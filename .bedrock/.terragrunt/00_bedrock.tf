################################################################################
# VERSIONS
################################################################################
terraform {
  required_version = ">= 1.2.7"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.37.0" # Latest version as of 2026-01-15
    }
  }
}

################################################################################
# Profiles - Interpolation is not supported for the 'version' input
################################################################################
# Default profile - used for global configs and where a provider is not defined
provider "aws" {
  region  = "us-east-1"
  profile = var.provider_profile
  ignore_tags {
    key_prefixes = ["kubernetes.io/"] # all resources will ignore any addition of tags with the kubernetes.io/ prefix
  }
}

##########################
# Region-specific profiles
##########################
# titanio-net 
provider "aws" {
  alias   = "titanio-net"
  region  = "us-east-1"
  profile = "titanio-net"
  ignore_tags {
    key_prefixes = ["kubernetes.io/"]
  }
}
# titanio-prd 
provider "aws" {
  alias   = "titanio-prd"
  region  = "us-east-1"
  profile = "titanio-prd"
  ignore_tags {
    key_prefixes = ["kubernetes.io/"]
  }
}

# Virginia 
provider "aws" {
  alias   = "use1"
  region  = "us-east-1"
  profile = var.provider_profile
  ignore_tags {
    key_prefixes = ["kubernetes.io/"]
  }
}
# Ohio 
provider "aws" {
  alias   = "use2"
  region  = "us-east-2"
  profile = var.provider_profile
  ignore_tags {
    key_prefixes = ["kubernetes.io/"]
  }
}
# California  
provider "aws" {
  alias   = "usw1"
  region  = "us-west-1"
  profile = var.provider_profile
  ignore_tags {
    key_prefixes = ["kubernetes.io/"]
  }
}
# Oregon 
provider "aws" {
  alias   = "usw2"
  region  = "us-west-2"
  profile = var.provider_profile
  ignore_tags {
    key_prefixes = ["kubernetes.io/"]
  }
}

# Frankfurt
provider "aws" {
  alias   = "euc1"
  region  = "eu-central-1"
  profile = var.provider_profile
  ignore_tags {
    key_prefixes = ["kubernetes.io/"]
  }
}
# Singapore 
provider "aws" {
  alias   = "apse1"
  region  = "ap-southeast-1"
  profile = var.provider_profile
  ignore_tags {
    key_prefixes = ["kubernetes.io/"]
  }
}
# Hong Kong 
provider "aws" {
  alias   = "ape1"
  region  = "ap-east-1"
  profile = var.provider_profile
  ignore_tags {
    key_prefixes = ["kubernetes.io/"]
  }
}
