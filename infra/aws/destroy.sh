#!/usr/bin/env bash
# Removes everything infra/aws/provision.sh created, as recorded in infra/aws/state.env.
# The backup bucket is emptied and deleted: download any backup you want to keep first.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
STATE=infra/aws/state.env
[ -f "$STATE" ] || { echo "no $STATE: nothing recorded to destroy" >&2; exit 1; }
# shellcheck disable=SC1090
. "$STATE"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
echo "Will delete in $AWS_REGION: instance ${INSTANCE:-none}, security group ${SG:-none}, instance profile ${PROFILE:-none}, role ${ROLE:-none}, bucket ${BUCKET:-none} and all its backups."
read -r -p "Type destroy to continue: " ok
[ "$ok" = destroy ] || { echo "aborted"; exit 1; }
if [ -n "${INSTANCE:-}" ]; then
  aws ec2 terminate-instances --instance-ids "$INSTANCE" >/dev/null && echo "terminating $INSTANCE"
  aws ec2 wait instance-terminated --instance-ids "$INSTANCE" && echo "terminated $INSTANCE (its 20 GB volume is deleted with it)"
fi
[ -n "${SG:-}" ] && aws ec2 delete-security-group --group-id "$SG" && echo "deleted $SG"
if [ -n "${PROFILE:-}" ]; then
  aws iam remove-role-from-instance-profile --instance-profile-name "$PROFILE" --role-name "${ROLE:-paidfor-audit-backup-role}" 2>/dev/null
  aws iam delete-instance-profile --instance-profile-name "$PROFILE" && echo "deleted instance profile $PROFILE"
fi
if [ -n "${ROLE:-}" ]; then
  aws iam delete-role-policy --role-name "$ROLE" --policy-name put-audit-backups 2>/dev/null
  aws iam delete-role --role-name "$ROLE" && echo "deleted role $ROLE"
fi
if [ -n "${BUCKET:-}" ]; then
  aws s3 rm "s3://$BUCKET" --recursive --only-show-errors
  aws s3api delete-bucket --bucket "$BUCKET" && echo "deleted bucket $BUCKET"
fi
left=$(aws resourcegroupstaggingapi get-resources --tag-filters Key=Name,Values=paidfor-audit --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null)
if [ -n "$left" ]; then echo "still tagged paidfor-audit (may be terminating): $left"; else rm -f "$STATE" infra/aws/deploy-key.pub; echo "all clear"; fi
echo "Remember to remove the deploy key: gh repo deploy-key list --repo sarmadahsan/x402-audit, then gh repo deploy-key delete <id> --repo sarmadahsan/x402-audit"
