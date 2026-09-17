remote_state {
  backend = "s3"
  generate = {
    path      = "00_TG_bedrock_init.tf"
    if_exists = "overwrite_terragrunt"
  }
  config = {
    profile         = "titanio-mst"
    bucket          = "titanio-terraform-states"
    use_lockfile    = true
    key             = "state/titanio/afs/collateral-margin/${substr(path_relative_to_include(),3, 3)}.tfstate"
    region          = "us-east-1"
    encrypt         = true
    kms_key_id      = "arn:aws:kms:us-east-1:228930573471:alias/foundation-cmk-s3"
    acl             = "bucket-owner-full-control"
  }
}

terraform {
  source = "../.terragrunt/"
}