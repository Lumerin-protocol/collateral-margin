# HPDX Monitoring & Alerting

Canonical guide for CloudWatch monitors and alarms in this repo. Agents and humans
must follow this when adding or changing monitoring.

## SNS topics (foundation-core owns these)

Do **not** create SNS topics in this repo. Look them up by name:

| Env | Slack (`#hpdx-alerts`) | Page (SMS + email) |
| --- | --- | --- |
| DEV | `titanio-dev-hpdx-alerts` | same as Slack (no separate page) |
| LMN | `titanio-lmn-hpdx-alerts` | `titanio-lmn-hpdx-page` |

```hcl
data "aws_sns_topic" "hpdx_alerts" {
  count = var.vault_monitoring.create && var.vault_monitoring.dev_alerts_topic_name != "" ? 1 : 0
  name  = var.vault_monitoring.dev_alerts_topic_name
}

data "aws_sns_topic" "hpdx_page" {
  count = var.vault_monitoring.create && var.vault_monitoring.devops_alerts_topic_name != "" ? 1 : 0
  name  = var.vault_monitoring.devops_alerts_topic_name
}
```

- Never hardcode ARNs.
- Never use `terraform_remote_state` for SNS.
- Never create orphan topics (e.g. `col-mar-futures-mm-alerts-*`).
- Wire tfvars topic **names**: `vault_monitoring.dev_alerts_topic_name` / `devops_alerts_topic_name`.

## Severity routing

| Severity | Non-prod (DEV) | Prod/LMN (`account_lifecycle == "prd"`) |
| --- | --- | --- |
| Warning | `hpdx-alerts` (Slack) | `hpdx-alerts` (Slack) |
| Critical | `hpdx-alerts` (Slack) | `hpdx-page` (SMS/email) |

Respect `vault_monitoring.notifications_enabled`.

## Alarm patterns in this repo

### Vault / portfolio health (`07_col_mar_vault_mon.tf`)

Individual alarms **do** notify, with an intentional **warn vs crit split**:

- Warning → `vault_warning_actions` (Slack)
- Critical → `vault_critical_actions` (page in LMN, Slack in DEV)

Use this pattern when different severities must page differently.

### Market makers (`05_futures_mm_mon.tf`, `05_perps_mm_mon.tf`)

1. Component metric alarms silent (`alarm_actions = []`).
2. One composite per MM notifies via `data.aws_sns_topic.*_mm_alerts` (foundation topic).
3. Gate on `futures_mm_service.create` / `perps_mm_service.create`.

## Checklist for a new monitor

1. Choose pattern: **composite** (service health) or **warn/crit split** (vault-style).
2. Lookup foundation topics — never create SNS.
3. Update DEV + LMN tfvars topic names if needed.
4. Plan must not add SNS topics; expect action rewires and/or one composite.

## This repo

- Vault: `07_col_mar_vault_mon.tf`
- Futures MM: `05_futures_mm_mon.tf` (composite `futures_mm_unhealthy`)
- Perps MM: `05_perps_mm_mon.tf` (composite `perps_mm_unhealthy`)
- Topic names: `.bedrock/02-dev` / `04-lmn` → `vault_monitoring {}`
