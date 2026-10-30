import { describe, it, expect, vi, afterEach } from "vitest";
import { createWorker } from "./worker.js";
import { createStreamingWorker } from "./worker-streaming.js";
import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { CompletedStepSchema } from "@ironflow/core/gen";
import { createFunction } from "./function.js";
import type { StepClient } from "@ironflow/core";

// Replace only the engine side of Connect; start(), message intake, the public
// function handler and the real production step client remain in the path.
const engine = vi.hoisted(() => ({ sent: [] as Array<{payload:{case?:string; value?:any}}>, steps: [] as unknown[], onTerminal: undefined as undefined | (()=>void) }));
vi.mock("@connectrpc/connect", async original => ({
 ...(await original<typeof import("@connectrpc/connect")>()),
 createClient: () => ({connect: (messages:AsyncIterable<unknown>, options?:{signal?:AbortSignal}) => {
  void (async () => {for await (const message of messages) { engine.sent.push(message as never); if (["jobFailed","jobCompleted"].includes((message as any).payload.case)) engine.onTerminal?.(); }})();
  return (async function* () {
   yield {payload:{case:"registered",value:{heartbeatIntervalMs:10000}}};
   yield {payload:{case:"job",value:{jobId:"job",runId:"run",functionId:"guard",attempt:1,executionSeq:1n,leaseToken:"token",event:{id:"e",name:"start",data:{},timestamp:undefined},completedSteps:engine.steps}}};
   await new Promise<void>(resolve => options?.signal?.addEventListener("abort",()=>resolve(),{once:true}));
  })();
 }}),
}));

afterEach(() => {vi.unstubAllGlobals();engine.sent.length=0;engine.steps=[];});

async function execute(transport:"rest"|"stream", handler:(step:StepClient)=>Promise<unknown>, memoizedNull=false, onTerminal?:()=>void) {
 engine.onTerminal=onTerminal;
 let terminal:any;
 let served=false;
 vi.stubGlobal("fetch",async (url:string,opts?:RequestInit) => {
  if(url.includes("/jobs") && (opts?.method??"GET")==="GET") {
   if(served) return new Response(null,{status:204});
   served=true;
   return Response.json({jobs:[{job_id:"job",run_id:"run",function_id:"guard",attempt:1,execution_seq:1,lease_token:"token",event:{id:"e",name:"start",data:{},timestamp:new Date().toISOString()},completed_steps:memoizedNull?[{step_id:"run:reply:0",name:"reply",status:"completed",output:null}]:[]}]});
  }
  if (opts?.method==="PUT" && url.endsWith("/jobs/job")) {terminal=JSON.parse(String(opts.body));if(["failed","completed"].includes(terminal.status))onTerminal?.();}
  return Response.json({});
 });
 const fn=createFunction({id:"guard",triggers:[]},async ({step})=>handler(step));
 if(transport==="stream") {
  if(memoizedNull) engine.steps=[create(CompletedStepSchema,{stepId:"run:reply:0",name:"reply",status:"completed",outputValue:fromJson(ValueSchema,null),outputJson:new TextEncoder().encode("null")})];
  const worker=createStreamingWorker({functions:[fn],serverUrl:"http://engine",logger:false});
  const running=worker.start();
  try {
   await vi.waitFor(()=>expect(engine.sent.some(m=>["jobFailed","jobCompleted","stepYielded"].includes(m.payload.case??""))).toBe(true));
   const last=engine.sent.find(m=>["jobFailed","jobCompleted","stepYielded"].includes(m.payload.case??""))!;
   return {status:last.payload.case,error:last.payload.value?.error,yield:last.payload.value?.yieldInfo,steps:last.payload.value?.steps};
  } finally {worker.stop();await running;}
 }
 const worker=createWorker({functions:[fn],serverUrl:"http://engine",logger:false});
 const running=worker.start();
 try {await vi.waitFor(()=>expect(terminal).toBeDefined());return terminal;} finally {await worker.stop();await running;}
}

describe.each(["rest","stream"] as const)("public %s handler",transport=>{
 for(const primitive of ["sleep","waitForEvent","invoke"] as const) {
  it.each([false,true])(`fails a swallowed ${primitive}, next=%s`,async next=>{
   let sideEffect=false;
   const terminal=await execute(transport,async step=>{
    try {
     if(primitive==="sleep")await step.sleep("pause","1h");
     else if(primitive==="waitForEvent")await step.waitForEvent("pause",{event:"reply"});
     else await step.invoke("child");
    }catch { /* Deliberately swallow to reproduce the application mistake. */ }
    if(next)await step.run("effect",async()=>{sideEffect=true;});
    return "bad";
   });
   expect(terminal.status).toBe(transport==="stream"?"jobFailed":"failed");
   expect(terminal.error.retryable).toBe(false);
   expect(terminal.error.message).toMatch(/yield.*caught|swallowed/i);
   expect(sideEffect).toBe(false);
  });
 }
 it.each(["wrapped", "replacement-yield"])("keeps a poisoned invocation terminal after an outer catch: %s",async mode=>{
  let refunded=false;
  const result=await execute(transport,async step=>{
   await step.run("charge",async()=>"paid");
   step.compensate("charge",async()=>{refunded=true;});
   try {
    await step.parallel("branches",[async branch=>{try{await branch.sleep("pause","1h");}catch { /* Application mistake. */ }return "bad";}]);
   } catch {
    if(mode==="replacement-yield")await step.sleep("another","1h");
    throw new Error("wrapped");
   }
  });
  expect(result.status).toBe(transport==="stream"?"jobFailed":"failed");
  expect(result.error.retryable).toBe(false);
  expect(result.error.message).toMatch(/yield.*caught|swallowed/i);
  expect(refunded).toBe(true);
  expect(result.steps).toContainEqual(expect.objectContaining({name:"compensate:charge",status:"completed"}));
 });
 it("reports a fatal swallowed yield after refunding the registered charge",async()=>{
  let refunded=false;
  const result=await execute(transport,async step=>{
   await step.run("charge",async()=>"paid");
   step.compensate("charge",async()=>{refunded=true;});
   try {await step.sleep("pause","1h");} catch { /* Application mistake. */ }
   return "invalid";
  });
  expect(refunded).toBe(true);
  expect(result.status).toBe(transport==="stream"?"jobFailed":"failed");
  expect(result.error.retryable).toBe(false);
  expect(result.steps).toContainEqual(expect.objectContaining({name:"compensate:charge",status:"completed"}));
 });
 it.each([undefined,2])("settles and records an already-running sibling before failure, concurrency=%s",async concurrency=>{
  let finished=false;
  let refunded=false;
  let finishedAtReport=false;
  const result=await execute(transport,step=>step.parallel("branches",[
   async branch=>{try {await branch.sleep("pause","1h");} catch { /* Application mistake. */ }return "bad";},
   async branch=>{const paid=await branch.run("charge",async()=>{await new Promise(resolve=>setTimeout(resolve,80));finished=true;return "paid";});branch.compensate("charge",async()=>{refunded=true;});return paid;}
  ],{concurrency}),false,()=>{finishedAtReport=finished;});
  expect(result.status).toBe(transport==="stream"?"jobFailed":"failed");
  expect(finishedAtReport).toBe(true);
  expect(refunded).toBe(true);
  expect(result.steps).toContainEqual(expect.objectContaining({type:"compensate",status:"completed"}));
  expect(result.steps).toContainEqual(expect.objectContaining({name:"charge",status:"completed"}));
 });
 it("replays a completed null without another yield",async()=>{
  const result=await execute(transport,step=>step.waitForEvent("reply",{event:"reply",onTimeout:"return-null"}),true);
  expect(result.status).toBe(transport==="stream"?"jobCompleted":"completed");
 });
 it("carries optional timeout policy through its yield",async()=>{
  const result=await execute(transport,step=>step.waitForEvent("reply",{event:"reply",onTimeout:"return-null"}));
  if(transport==="stream")expect(result.yield.value.onTimeout).toBe("return-null");
  else expect(result.yield.event_filter.on_timeout).toBe("return-null");
 });
});
