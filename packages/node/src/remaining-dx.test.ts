import { describe, it, expect } from "vitest";
import { serve } from "./serve.js";
import { createFunction } from "./function.js";
import { createStepClient } from "./step.js";
import { ExecutionContext } from "./internal/context.js";
import type { PushRequest, StepClient } from "@ironflow/core";

const request: PushRequest = {
 run_id: "run-guard", function_id: "guard", attempt: 1,
 event: { id: "trigger", name: "start", data: {}, timestamp: "2026-01-01T00:00:00Z" }, steps: [],
};

async function push(handler: (step: StepClient) => Promise<unknown>) {
 const fn = createFunction({id:"guard", triggers:[]}, async ({step}) => handler(step));
 const app = serve({functions:[fn], skipVerification:true, logger:false});
 const result = await app(new Request("http://localhost/api/ironflow", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(request)})) as Response;
 return result.json() as Promise<{status:string; error:{message:string;retryable:boolean}; steps:Array<{output:unknown;name?:string;status?:string}>}>;
}

describe("caught yielding primitives", () => {
 for (const primitive of ["sleep", "waitForEvent", "invoke"] as const) {
  for (const next of [false, true]) {
   it(`rejects swallowed ${primitive} before ${next ? "another step" : "completion"}`, async () => {
    let effect = false;
    const body = await push(async step => {
     try {
      if (primitive === "sleep") await step.sleep("pause", "1h");
      else if (primitive === "waitForEvent") await step.waitForEvent("pause", {event:"reply"});
      else await step.invoke("child");
     } catch { /* Application accidentally swallowed the SDK yield. */ }
     if (next) await step.run("effect", async () => {effect = true;});
     return "incorrect completion";
    });
    expect(body.status).toBe("failed");
    expect(body.error.retryable).toBe(false);
    expect(body.error.message).toMatch(/yield.*caught|swallowed/i);
    expect(effect).toBe(false);
   });
  }
 }
 it("rejects a branch that swallowed its yield even with allSettled", async () => {
  const body = await push(step => step.parallel("branches", [async branch => {
   try { await branch.sleep("pause", "1h"); } catch { /* Deliberately swallow to reproduce the application mistake. */ }
   return "invalid";
  }, async branch => branch.run("work", async () => "valid")], {onError:"allSettled"}));
  expect(body.status).toBe("failed");
  expect(body.error.retryable).toBe(false);
 });
 it("keeps a swallowed branch yield fatal when outer catches hide the guard", async () => {
  const body = await push(async step => {
   try {
    await step.parallel("branches", [async branch => {
     try { await branch.run("nested", async () => {try {await branch.sleep("pause", "1h");} catch { /* Deliberately swallow to reproduce the application mistake. */ } return 1;}); } catch { /* Deliberately swallow to reproduce the application mistake. */ }
     return "invalid";
    }], {onError:"allSettled"});
   } catch { /* Deliberately swallow to reproduce the application mistake. */ }
   return "incorrect completion";
  });
  expect(body.status).toBe("failed");
  expect(body.error.retryable).toBe(false);
 });
 it.each(["wrapped", "replacement-yield"])("keeps a poisoned invocation terminal after an outer catch: %s",async mode=>{
  let refunded=false;
  const result=await push(async step=>{
   await step.run("charge",async()=>"paid");
   step.compensate("charge",async()=>{refunded=true;});
   try {
    await step.parallel("branches",[async branch=>{try{await branch.sleep("pause","1h");}catch { /* Application mistake. */ }return "bad";}]);
   } catch {
    if(mode==="replacement-yield")await step.sleep("another","1h");
    throw new Error("wrapped");
   }
  });
  expect(result.status).toBe("failed");
  expect(result.error.retryable).toBe(false);
  expect(result.error.message).toMatch(/yield.*caught|swallowed/i);
  expect(refunded).toBe(true);
  expect(result.steps).toContainEqual(expect.objectContaining({name:"compensate:charge",status:"completed"}));
 });
 it("runs compensation and reports the swallowed yield as a terminal failure",async()=>{
  let refunded=false;
  const result=await push(async step=>{
   await step.run("charge",async()=>"paid");
   step.compensate("charge",async()=>{refunded=true;});
   try {await step.sleep("pause","1h");} catch { /* Application mistake. */ }
   return "bad";
  });
  expect(refunded).toBe(true);
  expect(result.status).toBe("failed");
  expect(result.error.retryable).toBe(false);
  expect(result.steps).toContainEqual(expect.objectContaining({name:"compensate:charge",status:"completed"}));
 });
 it("records completed parallel sibling work before reporting the fatal guard",async()=>{
  let finished=false;
  let refunded=false;
  const result=await push(step=>step.parallel("branches",[
   async branch=>{try{await branch.sleep("pause","1h");}catch { /* Application mistake. */ }return "bad";},
   async branch=>{const paid=await branch.run("charge",async()=>{await new Promise(resolve=>setTimeout(resolve,80));finished=true;return "paid";});branch.compensate("charge",async()=>{refunded=true;});return paid;}
  ]));
  expect(finished).toBe(true);
  expect(refunded).toBe(true);
  expect(result.steps).toContainEqual(expect.objectContaining({type:"compensate",status:"completed"}));
  expect(result.status).toBe("failed");
  expect(result.steps).toContainEqual(expect.objectContaining({name:"charge",status:"completed"}));
 });
 it("preserves ordinary parallel yielding and independent branches", async () => {
  const body = await push(step => step.parallel("branches", [async branch => branch.sleep("pause", "1h"), async branch => branch.run("work", async () => "valid")]));
  expect(body.status).toBe("yielded");
  expect(body.steps.some((step: {output: unknown}) => step.output === "valid")).toBe(true);
 });
});

describe("optional wait replay", () => {
 it("memoizes a completed JSON null without yielding again", async () => {
  const ctx = new ExecutionContext({...request, steps:[{id:"run-guard:reply:0", name:"reply", status:"completed", output:null}]});
  await expect(createStepClient(ctx).waitForEvent("reply", {event:"reply", onTimeout:"return-null"})).resolves.toBeNull();
 });
 it("fails loudly if a nullable wait is replayed with a nonnullable call", async () => {
  const ctx = new ExecutionContext({...request, steps:[{id:"run-guard:reply:0",name:"reply",status:"completed",output:null}]});
  await expect(createStepClient(ctx).waitForEvent("reply",{event:"reply"})).rejects.toMatchObject({retryable:false});
 });
 it("persists the explicit policy in the yield", async () => {
  const step = createStepClient(new ExecutionContext(request));
  await expect(step.waitForEvent("reply", {event:"reply", onTimeout:"return-null"})).rejects.toMatchObject({yieldInfo:{event_filter:{on_timeout:"return-null"}}});
 });
});
