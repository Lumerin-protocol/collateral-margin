include "root" {
  path = find_in_parent_folders("root.hcl")
}

include "public_config" {
  path = find_in_parent_folders("public-config.hcl")
}