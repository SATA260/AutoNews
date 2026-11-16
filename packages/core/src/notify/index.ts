export type NotifyEventType =
  | 'awaiting_review'
  | 'failed'
  | 'published'
  | 'publish_failed'
  | 'source_unhealthy'
  | 'schedule_skipped';

export interface NotifyEvent {
  type: NotifyEventType;
  runId?: string;
  message: string;
  data?: unknown;
}

export interface Notifier {
  id: string;
  notify(event: NotifyEvent): Promise<void>;
}

/**
 * Default v1 notifier: leaves external notifications unimplemented while
 * upstream workflow persists every event into `run_events`.
 */
export class NoopNotifier implements Notifier {
  readonly id = 'none';

  async notify(_event: NotifyEvent): Promise<void> {
    // v1 仅保留抽象接口，后期可按需接入飞书等通知渠道
  }
}
