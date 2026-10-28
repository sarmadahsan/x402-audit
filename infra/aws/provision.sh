#!/usr/bin/env bash
# Provisions the always-on paidfor-audit host. Every resource is tagged paidfor-audit and recorded in
# infra/aws/state.env so infra/aws/destroy.sh can remove exactly what this created.
# Usage: AWS_REGION=<region> MY_IP=<a.b.c.d> KEY_NAME=<ec2 key pair> [KEY_FILE=~/.ssh/<key>.pem] infra/aws/provision.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${AWS_REGION:?set AWS_REGION}"; : "${MY_IP:?set MY_IP (your public IPv4)}"; : "${KEY_NAME:?set KEY_NAME (existing EC2 key pair)}"
KEY_FILE="${KEY_FILE:-$HOME/.ssh/$KEY_NAME.pem}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
STATE=infra/aws/state.env
TAG=paidfor-audit
[ -e "$STATE" ] && { echo "$STATE exists: something is already provisioned. Run infra/aws/destroy.sh first." >&2; exit 1; }
[[ "$MY_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "MY_IP must be an IPv4 address" >&2; exit 1; }
aws ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null || { echo "key pair $KEY_NAME not found in $AWS_REGION" >&2; exit 1; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="paidfor-audit-backups-$ACCOUNT-$AWS_REGION"
ROLE=paidfor-audit-backup-role
PROFILE=paidfor-audit-instance-profile
SG_NAME=paidfor-audit-ssh
AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
[ "$VPC" != None ] || { echo "no default VPC in $AWS_REGION" >&2; exit 1; }

cat <<PLAN
Plan (account $ACCOUNT, region $AWS_REGION):
  S3 bucket      $BUCKET  (public access blocked, objects expire after 30 days)
  IAM role       $ROLE + instance profile $PROFILE  (only s3:PutObject on $BUCKET/audit/*)
  Security group $SG_NAME in $VPC  (inbound: tcp/22 from $MY_IP/32 only)
  Instance       t4g.small, $AMI (Ubuntu 24.04 arm64), 20 GB gp3, IMDSv2 required, key pair $KEY_NAME, tag $TAG
PLAN
read -r -p "Type yes to create these resources (this starts billing): " ok
[ "$ok" = yes ] || { echo "aborted"; exit 1; }

echo "ACCOUNT=$ACCOUNT" > "$STATE"; echo "AWS_REGION=$AWS_REGION" >> "$STATE"
rec() { echo "$1=$2" >> "$STATE"; }

# ---- S3
if [ "$AWS_REGION" = us-east-1 ]; then aws s3api create-bucket --bucket "$BUCKET" >/dev/null
else aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null; fi
rec BUCKET "$BUCKET"
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{"Rules":[{"ID":"expire-30d","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":30},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging "TagSet=[{Key=Name,Value=$TAG}]"

# ---- IAM
aws iam create-role --role-name "$ROLE" --tags Key=Name,Value=$TAG --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
rec ROLE "$ROLE"
aws iam put-role-policy --role-name "$ROLE" --policy-name put-audit-backups --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/audit/*\"}]}"
aws iam create-instance-profile --instance-profile-name "$PROFILE" --tags Key=Name,Value=$TAG >/dev/null
rec PROFILE "$PROFILE"
aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE" --role-name "$ROLE"
sleep 15   # instance profiles take a moment to become usable by EC2

# ---- Security group
SG=$(aws ec2 create-security-group --group-name "$SG_NAME" --description "paidfor-audit: SSH from operator IP only" --vpc-id "$VPC" \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$TAG}]" --query GroupId --output text)
rec SG "$SG"
aws ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MY_IP/32,Description=operator}]" >/dev/null

# ---- Instance
INSTANCE=$(aws ec2 run-instances --image-id "$AMI" --instance-type t4g.small --key-name "$KEY_NAME" --security-group-ids "$SG" \
  --iam-instance-profile Name="$PROFILE" \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true,Encrypted=true}' \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1 \
  --user-data file://infra/aws/user-data.sh \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$TAG}]" "ResourceType=volume,Tags=[{Key=Name,Value=$TAG}]" \
  --query 'Instances[0].InstanceId' --output text)
rec INSTANCE "$INSTANCE"
echo "launched $INSTANCE; waiting for it to run"
aws ec2 wait instance-running --instance-ids "$INSTANCE"
IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
rec IP "$IP"

# The server env file gets the bucket name (local file, gitignored).
[ -f data/server-audit.env ] && sed -i '' "s|^BACKUP_BUCKET=.*|BACKUP_BUCKET=$BUCKET|" data/server-audit.env

# ---- Deploy key (generated on the instance by user-data)
echo "waiting for cloud-init to finish on $IP (several minutes: Node, AWS CLI, Foundry)"
SSH=(ssh -i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "ubuntu@$IP")
until "${SSH[@]}" true 2>/dev/null; do sleep 10; done
"${SSH[@]}" "cloud-init status --wait >/dev/null; test -f /var/lib/paidfor-audit-bootstrap-done" || { echo "cloud-init failed; see /var/log/cloud-init-output.log on the host" >&2; exit 1; }
"${SSH[@]}" "sudo cat /home/audit/.ssh/id_audit_read.pub" > infra/aws/deploy-key-x402-audit-read.pub
"${SSH[@]}" "sudo cat /home/audit/.ssh/id_data_write.pub" > infra/aws/deploy-key-paidfor-data-write.pub

cat <<NEXT

Provisioned. Instance $INSTANCE at $IP; backups to s3://$BUCKET/audit/. State: $STATE.

1. Add the two deploy keys (read-only for the harness, write for the public data repo):
   gh repo deploy-key add infra/aws/deploy-key-x402-audit-read.pub --repo sarmadahsan/x402-audit --title "paidfor-audit $INSTANCE read"
   gh repo deploy-key add infra/aws/deploy-key-paidfor-data-write.pub --repo sarmadahsan/paidfor-data --title "paidfor-audit $INSTANCE write" --allow-write

2. Copy the database and env files:
   scp -i $KEY_FILE data/audit.sqlite data/server-audit.env data/server-wallets.env ubuntu@$IP:/tmp/

3. On the host (ssh -i $KEY_FILE ubuntu@$IP):
   sudo sh -c 'cat /tmp/server-audit.env /tmp/server-wallets.env > /etc/paidfor/audit.env && chmod 600 /etc/paidfor/audit.env' && rm /tmp/server-audit.env /tmp/server-wallets.env
   sudo -u audit git clone git@github-audit:sarmadahsan/x402-audit.git /home/audit/x402-audit
   sudo -u audit mkdir -p /home/audit/x402-audit/data && sudo install -o audit -g audit -m 600 /tmp/audit.sqlite /home/audit/x402-audit/data/audit.sqlite && rm /tmp/audit.sqlite
   sudo -u audit touch /home/audit/x402-audit/halt
   sudo -u audit bash -c 'cd /home/audit/x402-audit && pnpm install && ANVIL_BIN=/home/audit/.foundry/bin/anvil pnpm gate'
   sudo systemctl enable --now paidfor-audit
   sudo -u audit /home/audit/x402-audit/scripts/loop.sh status

The halt file keeps probes and buys off until you delete it. Teardown: infra/aws/destroy.sh
NEXT
