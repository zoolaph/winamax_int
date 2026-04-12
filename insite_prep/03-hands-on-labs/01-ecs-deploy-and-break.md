# Hands-On Lab 01 — Deploy an ECS Service and Break It

## Goal

Deploy a real containerized service to ECS Fargate. Then intentionally break it in 5 different ways and diagnose each failure from the error message alone — no hints.

**Time required:** 2-3 hours total  
**Cost:** under $2 on AWS free tier (Fargate tasks billed per second)  
**Prerequisites:** AWS CLI configured, Docker installed, an AWS account

---

## Part 1: Setup

### 1.1 — Create the app

Create a minimal Node.js HTTP server:

```bash
mkdir ecs-lab && cd ecs-lab
```

Create `app.js`:
```javascript
const http = require('http');

const PORT = parseInt(process.env.PORT || '3000');
const FAIL_HEALTH = process.env.FAIL_HEALTH === 'true';
const CRASH_ON_START = process.env.CRASH_ON_START === 'true';

if (CRASH_ON_START) {
  console.error('CRASH_ON_START is set — exiting');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    if (FAIL_HEALTH) {
      res.writeHead(500);
      res.end('unhealthy');
    } else {
      res.writeHead(200);
      res.end('ok');
    }
    return;
  }
  res.writeHead(200);
  res.end(`Hello from ${process.env.SERVICE_NAME || 'ecs-lab'}\n`);
});

server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
```

Create `Dockerfile`:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY app.js .
EXPOSE 3000
CMD ["node", "app.js"]
```

### 1.2 — Push to ECR

```bash
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=eu-west-3

# Create ECR repository
aws ecr create-repository --repository-name ecs-lab --region $AWS_REGION

# Login to ECR
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin \
    ${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com

# Build and push
docker build -t ecs-lab .
docker tag ecs-lab:latest ${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/ecs-lab:latest
docker push ${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/ecs-lab:latest
```

### 1.3 — Create networking infrastructure

```bash
# Get the default VPC and subnets (or use yours)
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

SUBNET_IDS=$(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')

# Create security group for ECS tasks
SG_ID=$(aws ec2 create-security-group \
  --group-name ecs-lab-sg \
  --description "ECS lab tasks" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

# Allow inbound on port 3000 (from anywhere for this lab)
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp --port 3000 --cidr 0.0.0.0/0

echo "SG_ID=$SG_ID"
echo "SUBNET_IDS=$SUBNET_IDS"
```

### 1.4 — Create IAM roles

```bash
# Task execution role
aws iam create-role \
  --role-name ecs-lab-execution-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name ecs-lab-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

### 1.5 — Register task definition

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=eu-west-3

aws ecs register-task-definition --cli-input-json "{
  \"family\": \"ecs-lab\",
  \"networkMode\": \"awsvpc\",
  \"requiresCompatibilities\": [\"FARGATE\"],
  \"cpu\": \"256\",
  \"memory\": \"512\",
  \"executionRoleArn\": \"arn:aws:iam::${ACCOUNT}:role/ecs-lab-execution-role\",
  \"containerDefinitions\": [{
    \"name\": \"ecs-lab\",
    \"image\": \"${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/ecs-lab:latest\",
    \"portMappings\": [{\"containerPort\": 3000, \"protocol\": \"tcp\"}],
    \"logConfiguration\": {
      \"logDriver\": \"awslogs\",
      \"options\": {
        \"awslogs-group\": \"/ecs/ecs-lab\",
        \"awslogs-region\": \"${REGION}\",
        \"awslogs-stream-prefix\": \"ecs\"
      }
    },
    \"environment\": [
      {\"name\": \"SERVICE_NAME\", \"value\": \"ecs-lab\"},
      {\"name\": \"PORT\", \"value\": \"3000\"}
    ]
  }]
}"
```

Create the CloudWatch log group:
```bash
aws logs create-log-group --log-group-name /ecs/ecs-lab --region $REGION
```

### 1.6 — Create ECS cluster and service

```bash
# Create cluster
aws ecs create-cluster --cluster-name ecs-lab-cluster

# Create service (standalone task — no ALB for simplicity)
aws ecs create-service \
  --cluster ecs-lab-cluster \
  --service-name ecs-lab \
  --task-definition ecs-lab \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[$(echo $SUBNET_IDS | cut -d, -f1)],
    securityGroups=[$SG_ID],
    assignPublicIp=ENABLED
  }"

# Wait for it to be stable
aws ecs wait services-stable --cluster ecs-lab-cluster --services ecs-lab
echo "Service is running"

# Get the task's public IP
TASK_ARN=$(aws ecs list-tasks --cluster ecs-lab-cluster --service-name ecs-lab \
  --query 'taskArns[0]' --output text)
  
ENI_ID=$(aws ecs describe-tasks --cluster ecs-lab-cluster --tasks $TASK_ARN \
  --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' \
  --output text)

PUBLIC_IP=$(aws ec2 describe-network-interfaces --network-interface-ids $ENI_ID \
  --query 'NetworkInterfaces[0].Association.PublicIp' --output text)

curl http://${PUBLIC_IP}:3000/
curl http://${PUBLIC_IP}:3000/health
```

---

## Part 2: Break It Exercises

For each break, trigger the failure, then diagnose it from the stopped reason / logs alone before reading the hint. After you fix it, verify the service is healthy again.

---

### Break 1 — Application crash on startup

**Trigger:**
```bash
# Update the service to set CRASH_ON_START=true
aws ecs register-task-definition --cli-input-json "$(aws ecs describe-task-definition \
  --task-definition ecs-lab --query taskDefinition | \
  jq '.containerDefinitions[0].environment += [{"name":"CRASH_ON_START","value":"true"}] |
      del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)')"

aws ecs update-service --cluster ecs-lab-cluster --service ecs-lab \
  --task-definition ecs-lab --force-new-deployment
```

**What you should observe:** Tasks start and immediately stop. Desired: 1, Running: 0.

**Diagnose from stopped reason. What is the exit code? What does it tell you?**

Check:
```bash
aws ecs describe-tasks --cluster ecs-lab-cluster \
  --tasks $(aws ecs list-tasks --cluster ecs-lab-cluster --desired-status STOPPED \
    --query 'taskArns[0]' --output text) \
  --query 'tasks[0].{StoppedReason:stoppedReason,ExitCode:containers[0].exitCode}'
```

**Fix:** Set `CRASH_ON_START=false` or remove the env var. Register new task definition. Update service.

---

### Break 2 — Remove the CloudWatch log group

```bash
aws logs delete-log-group --log-group-name /ecs/ecs-lab --region $REGION
aws ecs update-service --cluster ecs-lab-cluster --service ecs-lab --force-new-deployment
```

**What you should observe:** Task fails to start.

**Diagnose:** What is the stopped reason? How is this different from Break 1?

**Fix:** Recreate the log group. Force redeploy.

---

### Break 3 — Remove the ECR permission from the execution role

```bash
aws iam detach-role-policy \
  --role-name ecs-lab-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Add back only the logs permission (no ECR)
aws iam put-role-policy \
  --role-name ecs-lab-execution-role \
  --policy-name logs-only \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream","logs:PutLogEvents"],
      "Resource": "*"
    }]
  }'

aws ecs update-service --cluster ecs-lab-cluster --service ecs-lab --force-new-deployment
```

**Diagnose:** What is the stopped reason? How do you distinguish an ECR auth failure from a missing image?

**Fix:** Reattach `AmazonECSTaskExecutionRolePolicy`. Remove the inline policy. Force redeploy.

---

### Break 4 — Wrong port in the app (health check simulation)

```bash
# Change the app to listen on 8080 but the task definition still maps 3000
# Simulate by setting PORT=8080 in env (container listens on 8080)
# but the security group and any health check targets port 3000
aws ecs register-task-definition --cli-input-json "$(aws ecs describe-task-definition \
  --task-definition ecs-lab --query taskDefinition | \
  jq 'del(.environment[] | select(.name=="CRASH_ON_START")) |
      .containerDefinitions[0].environment = [{"name":"PORT","value":"8080"}] |
      del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)')"

aws ecs update-service --cluster ecs-lab-cluster --service ecs-lab \
  --task-definition ecs-lab --force-new-deployment
```

**What you should observe:** Task runs successfully. But requests to port 3000 fail.

**Diagnose:** How do you identify a port mismatch without stopping the task?

```bash
# Get the task's IP and test both ports
curl http://${PUBLIC_IP}:3000/ # fails
curl http://${PUBLIC_IP}:8080/ # works
```

This is the ALB health check scenario in production. Task is RUNNING, ALB says UNHEALTHY.

**Fix:** Update the task definition to expose port 8080, or change PORT back to 3000.

---

### Break 5 — Block outbound internet access (simulates missing NAT Gateway)

```bash
# Create a new SG with no outbound rules
SG_BROKEN=$(aws ec2 create-security-group \
  --group-name ecs-lab-no-egress \
  --description "No egress" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

# Remove the default egress rule
aws ec2 revoke-security-group-egress \
  --group-id $SG_BROKEN \
  --ip-permissions '[{"IpProtocol":"-1","IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]'

# Allow inbound on 3000 only
aws ec2 authorize-security-group-ingress \
  --group-id $SG_BROKEN --protocol tcp --port 3000 --cidr 0.0.0.0/0

# Update service with the broken SG
aws ecs update-service --cluster ecs-lab-cluster --service ecs-lab \
  --network-configuration "awsvpcConfiguration={
    subnets=[$(echo $SUBNET_IDS | cut -d, -f1)],
    securityGroups=[$SG_BROKEN],
    assignPublicIp=ENABLED
  }" --force-new-deployment
```

**What you observe:** Task fails to start. The stopped reason mentions ECR or secrets — even though ECR permissions are fine.

**Why?** ECR is accessed over HTTPS (port 443). No egress = no ECR pull. The error looks like a permissions problem but is actually a network problem.

**Diagnose:** How do you distinguish a network failure from a permissions failure in the stopped reason?

**Fix:** Restore the original SG.

---

## Part 3: Cleanup

```bash
# Scale down
aws ecs update-service --cluster ecs-lab-cluster --service ecs-lab --desired-count 0
aws ecs delete-service --cluster ecs-lab-cluster --service ecs-lab

# Delete cluster
aws ecs delete-cluster --cluster ecs-lab-cluster

# Delete ECR images and repo
aws ecr batch-delete-image --repository-name ecs-lab \
  --image-ids imageTag=latest
aws ecr delete-repository --repository-name ecs-lab

# Delete security groups
aws ec2 delete-security-group --group-id $SG_ID
aws ec2 delete-security-group --group-id $SG_BROKEN

# Delete IAM role
aws iam detach-role-policy --role-name ecs-lab-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name ecs-lab-execution-role

# Delete log group
aws logs delete-log-group --log-group-name /ecs/ecs-lab
```
