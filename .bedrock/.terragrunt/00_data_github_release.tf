################################################################################
# GitHub tag lookup for the portfolio market maker.
# This repo publishes git tags (col-mar-mm-vX.Y.Z and col-mar-mm-vX.Y.Z-dev),
# not GitHub Releases. The image tag is the version after "col-mar-mm-".
# matching-refs is lexicographic, so the newest tag is chosen by semver.
################################################################################

data "http" "futures_mm_github_tags" {
  count = var.futures_mm_service.create ? 1 : 0
  url   = "https://api.github.com/repos/${local.github_org_repo}/git/matching-refs/tags/col-mar-mm-v?per_page=100"

  request_headers = {
    Accept     = "application/vnd.github+json"
    User-Agent = "hashpower-terraform"
  }
}

locals {
  futures_mm_ghcr_repo = "ghcr.io/lumerin-protocol/collateral-margin-market-maker"

  futures_mm_tag_versions = var.futures_mm_service.create ? [
    for item in jsondecode(data.http.futures_mm_github_tags[0].response_body) :
    trimprefix(item.ref, "refs/tags/col-mar-mm-")
  ] : []

  # Padded semver prefix sorts lexicographically. "|version" keeps the tag.
  futures_mm_ranked_tags = sort([
    for v in local.futures_mm_tag_versions :
    format(
      "%05d.%05d.%05d|%s",
      tonumber(regex("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)", v)[0]),
      tonumber(regex("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)", v)[1]),
      tonumber(regex("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)", v)[2]),
      v,
    )
    if can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+(-dev)?$", v))
  ])

  futures_mm_dev_ranked = [
    for row in local.futures_mm_ranked_tags : row
    if endswith(split("|", row)[1], "-dev")
  ]
  futures_mm_prod_ranked = [
    for row in local.futures_mm_ranked_tags : row
    if can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+$", split("|", row)[1]))
  ]

  futures_mm_latest_dev_tag = length(local.futures_mm_dev_ranked) > 0 ? split("|", local.futures_mm_dev_ranked[length(local.futures_mm_dev_ranked) - 1])[1] : "v1.6.1-dev"
  futures_mm_latest_prod_tag = length(local.futures_mm_prod_ranked) > 0 ? split("|", local.futures_mm_prod_ranked[length(local.futures_mm_prod_ranked) - 1])[1] : "v1.6.0"

  # lmn is account_lifecycle "prd" and runs the unsuffixed tags.
  futures_mm_auto_image_tag = var.account_lifecycle == "prd" ? local.futures_mm_latest_prod_tag : local.futures_mm_latest_dev_tag
}

output "futures_mm_github_image_tag" {
  value       = var.futures_mm_service.create ? local.futures_mm_auto_image_tag : null
  description = "Newest market-maker image tag from GitHub, before the running task is considered"
}
