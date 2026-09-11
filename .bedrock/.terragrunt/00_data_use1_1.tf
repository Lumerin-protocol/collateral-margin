################################
# Regional DATA LOOKUPS 
################################

data "aws_vpc" "use1_1" {
  provider = aws.use1
  tags = {
    Name = "vpc-${var.region_shortname}-${var.vpc_index}-${var.account_shortname}"
  }
}
data "aws_internet_gateway" "use1_1" {
  provider = aws.use1
  filter {
    name   = "attachment.vpc-id"
    values = [data.aws_vpc.use1_1.id]
  }
}

data "aws_subnet" "edge_use1_1" {
  provider = aws.use1
  count    = 3
  filter {
    name   = "tag:Name"
    values = ["sn-use1-1-${var.account_shortname}-edge-${count.index + 1}"]
  }
  # in code for sgs, use the following: subnet_ids = [for n in data.aws_subnet.edge_use1_1 : n.id]
}

data "aws_subnet" "middle_use1_1" {
  provider = aws.use1
  count    = 3
  filter {
    name   = "tag:Name"
    values = ["sn-use1-1-${var.account_shortname}-middle-${count.index + 1}"]
  }
  # in code for sgs, use the following: subnet_ids = [for n in data.aws_subnet.middle_use1_1 : n.id]
}

data "aws_subnet" "private_use1_1" {
  provider = aws.use1
  count    = 3
  filter {
    name   = "tag:Name"
    values = ["sn-use1-1-${var.account_shortname}-private-${count.index + 1}"]
  }
  # in code for sgs, use the following: subnet_ids = [for n in data.aws_subnet.private_use1_1 : n.id]
}

data "aws_subnet" "edge_use1_1a" {
  provider = aws.use1
  filter {
    name   = "tag:Name"
    values = ["sn-use1-1-${var.account_shortname}-edge-1"]
  }
}

data "aws_subnet" "middle_use1_1a" {
  provider = aws.use1
  filter {
    name   = "tag:Name"
    values = ["sn-use1-1-${var.account_shortname}-middle-1"]
  }
}

# Regional ALB: ACM for the env public zone (hashpower.exchange or dev/stg.hashpower.exchange)
data "aws_acm_certificate" "lumerin_marketplace_ext" {
  provider    = aws.use1
  domain      = local.hp_dns["exc"].name
  types       = ["AMAZON_ISSUED"]
  most_recent = true
}

# CloudFront / website (if used): same zone as hp_acm["exc"]
data "aws_acm_certificate" "lumerin_marketplace_website" {
  provider    = aws.use1
  domain      = local.hp_dns["exc"].name
  types       = ["AMAZON_ISSUED"]
  most_recent = true
}

################################
# WAF Protection 
################################
data "aws_wafv2_web_acl" "bedrock_waf_use1_1" {
  provider = aws.use1
  name     = "waf-bedrock-use1-1"
  scope    = "REGIONAL"
}