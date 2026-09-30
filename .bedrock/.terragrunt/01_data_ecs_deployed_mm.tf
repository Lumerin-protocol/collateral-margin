################################################################################
# Image tag the futures market-maker service is actually running.
# Merged with the GitHub tag by semver so ghcr_vers = "auto" does not
# downgrade a CI deploy that is ahead of the tag list.
################################################################################

locals {
  futures_mm_ghcr_auto = var.futures_mm_service.ghcr_vers == "" || var.futures_mm_service.ghcr_vers == "auto"
  futures_mm_read_deployed = var.futures_mm_service.create && local.futures_mm_ghcr_auto
}

data "aws_ecs_service" "futures_mm_deployed" {
  count        = local.futures_mm_read_deployed ? 1 : 0
  provider     = aws.use1
  cluster_arn  = data.aws_ecs_cluster.derivatives.arn
  service_name = "svc-${local.shortname}-futures-mm-${substr(var.account_shortname, 8, 3)}"
}

data "aws_ecs_task_definition" "futures_mm_deployed" {
  count           = local.futures_mm_read_deployed ? 1 : 0
  provider        = aws.use1
  task_definition = data.aws_ecs_service.futures_mm_deployed[0].task_definition
}

locals {
  futures_mm_deployed_containers = local.futures_mm_read_deployed ? jsondecode(data.aws_ecs_task_definition.futures_mm_deployed[0].container_definitions) : []
  futures_mm_deployed_image = try([
    for c in local.futures_mm_deployed_containers : c.image
    if c.name == "${local.shortname}-futures-mm-container"
  ][0], null)
  futures_mm_deployed_image_tag = (
    local.futures_mm_deployed_image != null && startswith(local.futures_mm_deployed_image, "${local.futures_mm_ghcr_repo}:")
    ? trimprefix(local.futures_mm_deployed_image, "${local.futures_mm_ghcr_repo}:")
    : null
  )

  # regex() returns capture groups only: major, minor, patch, optional "-dev".
  futures_mm_github_semver = can(regex("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)(-dev)?$", local.futures_mm_auto_image_tag)) ? regex("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)(-dev)?$", local.futures_mm_auto_image_tag) : null
  futures_mm_deployed_semver = (
    local.futures_mm_deployed_image_tag != null && can(regex("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)(-dev)?$", local.futures_mm_deployed_image_tag))
    ? regex("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)(-dev)?$", local.futures_mm_deployed_image_tag)
    : null
  )

  # Higher semver wins. A tie keeps the GitHub tag.
  futures_mm_image_tag_auto = (
    local.futures_mm_deployed_image_tag == null ? local.futures_mm_auto_image_tag : (
      local.futures_mm_github_semver == null ? local.futures_mm_auto_image_tag : (
        local.futures_mm_deployed_semver == null ? local.futures_mm_auto_image_tag : (
          tonumber(local.futures_mm_deployed_semver[0]) > tonumber(local.futures_mm_github_semver[0]) ? local.futures_mm_deployed_image_tag : (
            tonumber(local.futures_mm_deployed_semver[0]) < tonumber(local.futures_mm_github_semver[0]) ? local.futures_mm_auto_image_tag : (
              tonumber(local.futures_mm_deployed_semver[1]) > tonumber(local.futures_mm_github_semver[1]) ? local.futures_mm_deployed_image_tag : (
                tonumber(local.futures_mm_deployed_semver[1]) < tonumber(local.futures_mm_github_semver[1]) ? local.futures_mm_auto_image_tag : (
                  tonumber(local.futures_mm_deployed_semver[2]) > tonumber(local.futures_mm_github_semver[2]) ? local.futures_mm_deployed_image_tag : (
                    tonumber(local.futures_mm_deployed_semver[2]) < tonumber(local.futures_mm_github_semver[2]) ? local.futures_mm_auto_image_tag : local.futures_mm_auto_image_tag
                  )
                )
              )
            )
          )
        )
      )
    )
  )

  futures_mm_image_tag = local.futures_mm_ghcr_auto ? local.futures_mm_image_tag_auto : var.futures_mm_service.ghcr_vers
}

# The image tag is normally an annotated git tag (col-mar-mm-vX.Y.Z[-dev]).
# A 422 means CI deployed the image and then failed verification, so the
# tag was never pushed. COMMIT_HASH is already on that running task.
data "http" "futures_mm_image_commit" {
  count = var.futures_mm_service.create ? 1 : 0
  url   = "https://api.github.com/repos/${local.github_org_repo}/commits/col-mar-mm-${local.futures_mm_image_tag}"

  request_headers = {
    Accept     = "application/vnd.github+json"
    User-Agent = "hashpower-terraform"
  }
}

locals {
  futures_mm_tag_commit = (
    var.futures_mm_service.create && try(data.http.futures_mm_image_commit[0].status_code, 0) == 200
    ? try(jsondecode(data.http.futures_mm_image_commit[0].response_body).sha, "")
    : ""
  )
  futures_mm_deployed_commit = try([
    for container in local.futures_mm_deployed_containers : [
      for env in try(container.environment, []) : env.value
      if env.name == "COMMIT_HASH"
    ][0]
    if container.name == "${local.shortname}-futures-mm-container"
  ][0], "")
  futures_mm_commit_hash = (
    local.futures_mm_tag_commit != "" ? local.futures_mm_tag_commit : (
      local.futures_mm_deployed_commit != "" ? local.futures_mm_deployed_commit : "unknown"
    )
  )
}

output "futures_mm_deployed_image_tag" {
  value       = var.futures_mm_service.create ? local.futures_mm_deployed_image_tag : null
  description = "Image tag on the task definition the futures market-maker service is running"
}

output "futures_mm_image_tag" {
  value       = var.futures_mm_service.create ? local.futures_mm_image_tag : null
  description = "Image tag a rebuilt futures task definition will use"
}

output "futures_mm_commit_hash" {
  value       = var.futures_mm_service.create ? local.futures_mm_commit_hash : null
  description = "Commit for the resolved image. The git tag when it exists, otherwise the COMMIT_HASH already on the running task."
}
