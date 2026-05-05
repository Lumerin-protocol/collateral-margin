##########################
# DNS Lookup specific profile
##########################
provider "aws" {
  alias   = "special-dns"
  region  = "us-east-1"
  profile = var.provider_profile # or `titanio-prd` for DNS roots held by Old Prod account or `titanio-net` for DNS roots held by Bedrock
  ignore_tags {
    key_prefixes = ["kubernetes.io/"]
  }
}

