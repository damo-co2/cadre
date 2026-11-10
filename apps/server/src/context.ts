import type { Store } from "@grokbot/db";
import type { DriverRegistry } from "@grokbot/model-drivers";
import type { AgentRuntime } from "@grokbot/agent-runtime";
import type { ComputerService } from "@grokbot/sandbox";
import type { ServerEvent } from "@grokbot/shared";

export type AppEnv = {
  Variables: {
    store: Store;
    drivers: DriverRegistry;
    runtime: AgentRuntime;
    computer: ComputerService;
    emit: (e: ServerEvent) => void;
  };
};
