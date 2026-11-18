/** 通知系统支持的事件类型 */
export type NotifyEventType =
  | 'awaiting_audio_review'
  | 'awaiting_review'
  | 'failed'
  | 'published'
  | 'publish_failed'
  | 'source_unhealthy'
  | 'schedule_skipped';

/** 派发外部通知时携带的事件内容 */
export interface NotifyEvent {
  type: NotifyEventType;
  runId?: string;
  message: string;
  data?: unknown;
}

/** 外部消息通知抽象接口，后期可接入飞书等具体通知渠道 */
export interface Notifier {
  id: string;
  /** 发送一条通知消息 */
  notify(event: NotifyEvent): Promise<void>;
}

/** 默认的空通知实现：不向外部发送消息，所有事件均已保存在数据库日志中 */
export class NoopNotifier implements Notifier {
  readonly id = 'none';

  /** 空实现方法，预留给后期接入飞书等实际通知渠道时替换 */
  async notify(_event: NotifyEvent): Promise<void> {}
}
