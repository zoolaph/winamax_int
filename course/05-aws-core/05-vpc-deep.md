# VPC — Deep Dive

## What a VPC actually is

A VPC (Virtual Private Cloud) is a logically isolated network inside AWS. You define the address space (CIDR block), divide it into subnets, and control routing. Everything runs inside your VPC — ECS tasks, RDS, load balancers — unless you explicitly connect it to the outside world.

Think of a VPC as your data center's private network, but fully software-defined. AWS owns the hardware; you own the routing rules.

---

## CIDR and subnets

You pick a CIDR block for the VPC, e.g., `10.0.0.0/16`. That gives you 65,536 addresses.

You subdivide it into subnets. Each subnet lives in exactly one Availability Zone.

```
VPC: 10.0.0.0/16

  AZ-A:
    Public subnet:  10.0.1.0/24   (256 addresses, 251 usable — AWS reserves 5)
    Private subnet: 10.0.2.0/24

  AZ-B:
    Public subnet:  10.0.3.0/24
    Private subnet: 10.0.4.0/24

  AZ-C:
    Public subnet:  10.0.5.0/24
    Private subnet: 10.0.6.0/24
```

**What makes a subnet "public"?** Its route table has a route `0.0.0.0/0 → igw-xxx` (Internet Gateway). That is the only difference between public and private subnets. The CIDR range does not matter.

---

## Route tables

Every subnet is associated with a route table. The route table is a list of destination → target rules.

```
Public subnet route table:
  10.0.0.0/16   local        ← traffic within the VPC stays local
  0.0.0.0/0     igw-abc123   ← everything else goes to the Internet Gateway

Private subnet route table:
  10.0.0.0/16   local
  0.0.0.0/0     nat-xyz789   ← outbound internet goes via NAT Gateway
```

Route lookup is longest-prefix-match. The `local` route always wins for intra-VPC traffic.

---

## Internet Gateway (IGW)

The IGW is a horizontally scaled, redundant AWS-managed gateway attached to your VPC. It performs 1:1 NAT for resources that have a public IP address.

- A resource in a public subnet with a public IP + an IGW in its route table can receive inbound internet connections and make outbound connections.
- The IGW itself has no bandwidth limit or single point of failure.

---

## NAT Gateway

A NAT Gateway lets resources in a **private subnet** make outbound connections to the internet, without being reachable from the internet.

Architecture:
1. You create a NAT Gateway **in a public subnet** and assign it an Elastic IP.
2. The private subnet's route table points `0.0.0.0/0` to the NAT Gateway.
3. The NAT Gateway translates the private IP to its Elastic IP for outbound traffic.

**Key facts:**
- NAT Gateway is AZ-scoped. For HA, deploy one per AZ and update each AZ's private subnets to use the NAT Gateway in the same AZ.
- Cost: ~$0.045/hour + $0.045/GB of data processed. Large-scale outbound traffic (e.g., pulling container images) can make this expensive.
- NAT Gateway cannot be used for inbound access — it is outbound only.

**Why private subnets need NAT:** ECS tasks in private subnets still need to pull images from ECR, reach AWS APIs (for Secrets Manager, SQS, etc.), and download software. NAT Gateway provides this without exposing the tasks to inbound internet.

---

## VPC Endpoints

A VPC Endpoint lets your resources reach AWS services **without going through NAT Gateway or the internet**. Traffic stays within the AWS network.

Two types:
- **Gateway Endpoint** — S3 and DynamoDB only. Free. You add it to route tables.
- **Interface Endpoint (PrivateLink)** — ENI with a private IP in your subnet. Works for ECR, Secrets Manager, SQS, CloudWatch, and ~100 other services. Costs ~$0.01/hour/AZ.

**Why this matters for Winamax:** If ECS tasks in private subnets pull images from ECR, and they go through NAT Gateway, you pay $0.045/GB for image traffic. With a VPC Endpoint for ECR (Interface Endpoint), that traffic is free and stays on the AWS network. At their scale of thousands of task starts, this is significant.

---

## VPC Peering and Transit Gateway

**VPC Peering** — direct network link between two VPCs. Traffic is private, uses private IPs. Limitations: not transitive (if VPC-A peers with VPC-B and VPC-B peers with VPC-C, A cannot talk to C through B), and you need route table entries on both sides.

**Transit Gateway** — a managed hub that connects many VPCs and on-premises networks. Transitive routing works. Required once you have more than a handful of VPCs or need on-premises connectivity.

---

## Winamax VPC design inference

Given 700+ microservices and production AWS workloads, Winamax almost certainly has:
- Multiple VPCs (at least prod, staging, tooling)
- Private subnets for all ECS tasks and databases
- Public subnets only for load balancers and NAT Gateways
- VPC Endpoints for ECR, Secrets Manager, S3 (cost and security)
- Transit Gateway or VPC Peering for cross-VPC connectivity

**K8s bridge:** In Kubernetes, pods communicate over a flat cluster network managed by the CNI plugin. In VPC, communication between services goes through private IPs, with security groups as the access control layer. The mental model is similar — everything has a private IP, routing is automatic within the boundary, and you control egress/ingress at the edges.

---

## Common interview traps

**"My ECS task can't reach ECR to pull its image. What do you check?"**

1. Does the task's subnet have a route to the internet? (NAT Gateway, or VPC Endpoint for ECR)
2. Does the task's security group allow outbound HTTPS (443) to `0.0.0.0/0` or the ECR endpoint?
3. Does the `executionRoleArn` have ECR pull permissions? (separate from networking)
4. If using VPC Endpoints: is the ECR endpoint in the same AZ? Are the endpoint's security groups correct?

**"What's the difference between a private subnet and a private IP?"**

A private IP is any IP in RFC 1918 space (10.x, 172.16-31.x, 192.168.x). A private *subnet* is a subnet whose route table has no route to an IGW. A resource in a "public" subnet with only a private IP (no Elastic IP) cannot receive inbound internet traffic even though the IGW route exists — there is no public IP for the IGW to NAT to.
