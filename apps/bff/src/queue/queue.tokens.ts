import type { Queue } from 'bullmq';
import type { RunJob } from './run-job';

/** 队列运行时配置的注入令牌。 */
export const QUEUE_CONFIG = Symbol('QUEUE_CONFIG');

/** 运行队列的注入令牌；队列关闭时值为 null。 */
export const RUN_QUEUE = Symbol('RUN_QUEUE');

/** 运行事件总线的注入令牌（Nest 无法用接口类型作 token）。 */
export const RUN_EVENT_BUS = Symbol('RUN_EVENT_BUS');

/** 运行控制总线的注入令牌。 */
export const RUN_CONTROL_BUS = Symbol('RUN_CONTROL_BUS');

/** 队列作业统一名与数据类型；所有运行共用同一条队列。 */
export const RUN_JOB_NAME = 'run';
export type RunQueue = Queue<RunJob, void, typeof RUN_JOB_NAME>;
