# Fargate Spot Capacity Provider Setup

This setup configures automatic cost optimization for the Ananda crawler using AWS Fargate Spot instances with
intelligent fallback to on-demand capacity.

## Overview

- **95% Fargate Spot**: Maximum cost savings (~70% cheaper than on-demand)
- **5% Fargate on-demand**: Automatic fallback during Spot capacity shortages
- **Uses built-in capacity providers**: FARGATE_SPOT and FARGATE (no custom creation needed)
- **Automatic failover**: No manual intervention required
- **CloudWatch monitoring**: Alerts when Spot capacity is constrained

## Architecture

```
┌─────────────────┐    ┌──────────────────────┐
│   ECS Service   │────│  Capacity Provider   │
│                 │    │  Strategy:           │
│ desired_count=1 │    │  - Spot: 95% weight  │
│                 │    │  - On-demand: 5%     │
└─────────────────┘    └──────────────────────┘
         │                           │
         └───────────────────────────┘
                 │
        ┌────────▼────────┐
        │  ECS Cluster    │
        │                 │
        │ - Auto-scaling  │
        │ - Spot failover │
        └─────────────────┘
```

## Cost Savings

- **Fargate Spot**: ~$0.01344/hour (70% savings)
- **Fargate on-demand**: ~$0.04656/hour
- **Weighted average**: ~$0.017/hour (63% savings vs pure on-demand)

## Setup Instructions

### One-time Setup

```bash
# Run the setup script to create capacity provider and service
./setup-spot-capacity.sh
```

This creates:

- Configures ECS cluster to use built-in FARGATE_SPOT and FARGATE capacity providers
- Creates/updates ECS service with capacity provider strategy (95% Spot / 5% on-demand)
- Sets up CloudWatch alarm for on-demand capacity usage monitoring

### Daily Operation

Use the service control script instead of manual run-task:

```bash
# Start crawler
./service-control.sh start

# Stop crawler
./service-control.sh stop

# Check status (shows capacity type used)
./service-control.sh status

# Scale to multiple instances if needed
./service-control.sh scale 2

# Force restart (useful for config changes)
./service-control.sh restart
```

## Monitoring

### Service Status

```bash
./service-control.sh status
```

Shows:

- Service health (desired/running/pending counts)
- Which capacity type each task is using (Spot vs on-demand)
- Capacity provider utilization percentages

### CloudWatch Alarms

The setup creates an alarm `ananda-crawler-spot-capacity-low` that triggers when:

- On-demand capacity usage > 50% for 30+ minutes
- Sends alerts to SNS topic `ananda-crawler-alerts`

### Logs

```bash
# View crawler logs
aws logs tail /ecs/ananda-crawler --follow --region us-west-1

# View capacity provider metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS/ManagedScaling \
  --metric-name CapacityProviderReservation \
  --dimensions Name=CapacityProviderName,Value=ananda-crawler-capacity-provider Name=ClusterName,Value=ananda-crawler-cluster \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-02T00:00:00Z \
  --period 3600 \
  --statistics Maximum
```

## How Spot Failover Works

1. **Normal Operation**: Tasks run on Spot capacity (95% of the time)
2. **Spot Shortage**: When Spot capacity is unavailable, tasks automatically start on on-demand (5%)
3. **Recovery**: When Spot capacity returns, new tasks automatically use Spot again
4. **No Downtime**: Existing tasks continue running until completion or manual restart

## Migration from Manual Tasks

If you're currently using `manual-control.sh` with `run-task`:

1. **Run setup**: `./setup-spot-capacity.sh` (creates service)
2. **Switch to service control**: Use `./service-control.sh` instead
3. **Update EventBridge schedule**: Modify to start service instead of run-task (see below)
4. **Keep manual control**: Still available for debugging/emergencies

### Updating EventBridge Schedule for Spot Capacity

After setting up the service with capacity provider, update your EventBridge schedule to work with services:

```bash
# Run this script to update EventBridge schedules for service-based control
./update-schedule-for-service.sh
```

**What this does:**

- Updates EventBridge to run tasks with `CapacityProviderStrategy` instead of `LaunchType`
- Maintains 9am PT start time (16:00 UTC)
- Tasks still auto-stop after 8 hours due to max-runtime-minutes
- **Enables Spot capacity**: Uses FARGATE_SPOT (95% weight) and FARGATE (5% weight)
- Tasks automatically use Spot when available, fallback to on-demand when Spot is constrained

**Before vs After:**

- **Before**: EventBridge runs tasks with `LaunchType=FARGATE` (always on-demand, ~$0.04656/hour)
- **After**: EventBridge runs tasks with `CapacityProviderStrategy` (mostly Spot ~$0.01344/hour, auto-failover)

## Troubleshooting

### Tasks Not Starting

```bash
# Check service events
aws ecs describe-services \
  --cluster ananda-crawler-cluster \
  --services ananda-crawler-service \
  --region us-west-1 \
  --query 'services[0].events[0:5]'
```

### Spot Capacity Issues

```bash
# Check service capacity provider strategy
aws ecs describe-services \
  --cluster ananda-crawler-cluster \
  --services ananda-crawler-service \
  --region us-west-1 \
  --query 'services[0].capacityProviderStrategy'

# Check running tasks and their capacity providers
aws ecs list-tasks \
  --cluster ananda-crawler-cluster \
  --service-name ananda-crawler-service \
  --region us-west-1 \
  --query 'taskArns[]' \
  --output text | xargs aws ecs describe-tasks \
  --cluster ananda-crawler-cluster \
  --tasks {} \
  --region us-west-1 \
  --query 'tasks[*].{Task:taskArn, Capacity:capacityProviderName}' \
  --output table
```

### Force On-Demand (Emergency)

Temporarily update service to use only FARGATE (on-demand):

```bash
aws ecs update-service \
  --cluster ananda-crawler-cluster \
  --service ananda-crawler-service \
  --capacity-provider-strategy "capacityProvider=FARGATE,weight=1" \
  --region us-west-1 \
  --force-new-deployment
```

### Restore Spot Configuration

```bash
aws ecs update-service \
  --cluster ananda-crawler-cluster \
  --service ananda-crawler-service \
  --capacity-provider-strategy "capacityProvider=FARGATE_SPOT,weight=95" "capacityProvider=FARGATE,weight=5" \
  --region us-west-1 \
  --force-new-deployment
```

## Security Notes

- No changes to security groups or network configuration
- Tasks still use hardened security group (`crawler-hardened-sg`)
- Public IP assignment maintained for outbound-only access
- No inbound ports exposed

## Cost Monitoring

Track costs in AWS Cost Explorer:

- Filter by: Service = "Amazon Elastic Container Service"
- Group by: Capacity Type (Spot vs On-Demand)

Expected monthly savings: ~$20-30 compared to pure on-demand operation.
