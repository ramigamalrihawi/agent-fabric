export type SessionRow = {
  id: string;
  origin_peer_id: string;
  agent_id: string;
  display_name: string;
  host_name: string;
  host_version: string | null;
  transport: string;
  workspace_root: string;
  workspace_source: string;
  capabilities_json: string;
  notifications_declared: "yes" | "no" | "unknown";
  notifications_observed: "yes" | "no" | "unknown";
  notification_self_test_json: string | null;
  litellm_routeable: 0 | 1;
  outcome_reporting: string;
  session_token_hash: string;
  expires_at: string | null;
  started_at: string;
  last_heartbeat_at: string | null;
  ended_at: string | null;
  warnings_json: string;
  test_mode: 0 | 1;
};

export type NotificationSelfTestRow = {
  id: string;
  session_id: string;
  agent_id: string;
  host_name: string;
  workspace_root: string;
  challenge: string;
  status: "pending" | "completed" | "expired";
  requested_at: string;
  expires_at: string;
  completed_at: string | null;
  observed: "yes" | "no" | "unknown";
  detail: string | null;
};
