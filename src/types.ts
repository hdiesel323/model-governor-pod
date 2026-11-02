export interface PodConfig {
  id: string;
  name: string;
  role: string;
  lob: string;
  capabilities: string[];
  hubUrl: string;
  apiKey?: string;
  port?: number;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface TaskRecord<TSpec = any, TResult = any> {
  id: number;
  taskId: string;
  topic: string;
  source: string;
  spec: TSpec;
  status: TaskStatus;
  result?: TResult;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HandlerContext {
  podConfig: PodConfig;
  now: number;
  publishEvent: (topic: string, toPod: string, payload: any) => Promise<void>;
}

export interface TaskHandler<TSpec = any, TResult = any> {
  name: string;
  canHandle(topic: string, spec: TSpec): boolean;
  handle(task: TaskRecord<TSpec>, context: HandlerContext): Promise<TResult>;
}

export interface TincanEnvelope<T = any> {
  id: string;
  topic: string;
  fromPod: string;
  toPod: string;
  payload: T;
  status: "pending" | "delivered" | "acknowledged";
  createdAt: number;
  deliveredAt?: number;
}
