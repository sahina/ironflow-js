import { UpcasterRegistry, type UpcasterFn } from "./upcaster.js";

export interface EventDefinitionOptions {
  name: string;
  version: number;
  upcast?: UpcasterFn;
}

export interface EventDefinition {
  name: string;
  version: number;
  upcast?: UpcasterFn;
}

export function defineEvent(options: EventDefinitionOptions): EventDefinition {
  return {
    name: options.name,
    version: options.version,
    upcast: options.upcast,
  };
}

export class EventDefinitionRegistry {
  private upcasterRegistry = new UpcasterRegistry();
  private versions = new Map<string, number[]>();

  register(definition: EventDefinition): void {
    if (!this.versions.has(definition.name)) {
      this.versions.set(definition.name, []);
    }
    this.versions.get(definition.name)!.push(definition.version);

    if (definition.upcast && definition.version > 1) {
      this.upcasterRegistry.register(
        definition.name,
        definition.version - 1,
        definition.version,
        definition.upcast
      );
    }
  }

  upcastEvent(eventName: string, data: unknown, fromVersion: number): unknown {
    const latestVersion = this.getLatestVersion(eventName);
    if (latestVersion === undefined || fromVersion >= latestVersion) {
      return data;
    }
    return this.upcasterRegistry.upcast(eventName, data, fromVersion, latestVersion);
  }

  getLatestVersion(eventName: string): number | undefined {
    const versions = this.versions.get(eventName);
    if (!versions || versions.length === 0) {
      return undefined;
    }
    return Math.max(...versions);
  }
}

export function createEventDefinitionRegistry(): EventDefinitionRegistry {
  return new EventDefinitionRegistry();
}
