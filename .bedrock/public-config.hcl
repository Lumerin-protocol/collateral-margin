# Public runtime values from config/<env>.env. Included by each stack; the
# stack directory picks the file (02-dev → dev.env, 04-lmn → prd.env).

locals {
  stack = basename(get_original_terragrunt_dir())
  config_env_file = {
    "02-dev" = "dev.env"
    "04-lmn" = "prd.env"
  }[local.stack]

  # Stack dirs are .bedrock/<stack>, so the repo config/ is two levels up.
  config_env_path = "${get_original_terragrunt_dir()}/../../config/${local.config_env_file}"

  config_env = {
    for line in split("\n", file(local.config_env_path)) :
    trimspace(regex("^([^=]+)=(.*)$", trimspace(line))[0]) => trimspace(regex("^([^=]+)=(.*)$", trimspace(line))[1])
    if length(trimspace(line)) > 0 && substr(trimspace(line), 0, 1) != "#"
  }
}

inputs = {
  vault_env = {
    subgraph_url        = local.config_env["VAULT_SUBGRAPH_URL"]
    points_subgraph_url = local.config_env["POINTS_SUBGRAPH_URL"]
    vault_address       = local.config_env["VAULT_ADDRESS"]
    futures_address     = local.config_env["FUTURES_ADDRESS"]
    perps_address       = local.config_env["PERPS_ADDRESS"]
  }
}
