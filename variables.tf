variable "subscription_id" {
  type        = string
  default     = null
  description = "Azure subscription ID. Leave null to use the current Azure CLI subscription."
}

variable "location" {
  type        = string
  default     = "westus2"
  description = "Azure region for all AVD starter resources."
}

variable "resource_group_name" {
  type        = string
  default     = "rg-avd-starter"
  description = "Resource group name for the AVD starter deployment."
}

variable "name_prefix" {
  type        = string
  default     = "avd-starter"
  description = "Prefix used for resource names. Use letters, numbers, and hyphens."

  validation {
    condition     = can(regex("^[A-Za-z0-9-]{2,12}$", var.name_prefix))
    error_message = "name_prefix must be 2-12 characters and contain only letters, numbers, and hyphens."
  }
}

variable "session_host_count" {
  type        = number
  default     = 1
  description = "Number of AVD session hosts to deploy."

  validation {
    condition     = var.session_host_count >= 1 && var.session_host_count <= 10
    error_message = "session_host_count must be between 1 and 10."
  }
}

variable "maximum_sessions_allowed" {
  type        = number
  default     = 2
  description = "Maximum concurrent sessions allowed per session host."
}

variable "vnet_address_space" {
  type        = string
  default     = "10.40.0.0/16"
  description = "Address space for the AVD virtual network."
}

variable "session_host_subnet_prefix" {
  type        = string
  default     = "10.40.1.0/24"
  description = "Subnet prefix for AVD session host NICs."
}

variable "vm_size" {
  type        = string
  default     = "Standard_D2s_v5"
  description = "Azure VM size for each session host."
}

variable "session_host_image_sku" {
  type        = string
  default     = "win11-24h2-avd"
  description = "Windows 11 Enterprise multi-session image SKU for session hosts."
}

variable "os_disk_storage_account_type" {
  type        = string
  default     = "Premium_LRS"
  description = "Managed OS disk storage type."
}

variable "local_admin_username" {
  type        = string
  default     = "avdlocaladmin"
  description = "Local administrator username for the session host VM."
}

variable "rdp_source_address_prefix" {
  type        = string
  default     = null
  nullable    = true
  description = "Optional public source IP/CIDR allowed to reach session hosts over RDP. Leave null to avoid inbound RDP."

  validation {
    condition     = var.rdp_source_address_prefix == null || can(cidrhost(var.rdp_source_address_prefix, 0))
    error_message = "rdp_source_address_prefix must be null or a valid CIDR block, such as 203.0.113.10/32."
  }
}

variable "avd_user_object_ids" {
  type        = list(string)
  default     = []
  description = "Microsoft Entra user or group object IDs granted access to the AVD desktop and VM login."
}

variable "avd_admin_object_ids" {
  type        = list(string)
  default     = []
  description = "Microsoft Entra user or group object IDs granted administrator login on the session hosts."
}

variable "tags" {
  type = map(string)
  default = {
    workload    = "avd"
    environment = "starter"
    managed_by  = "terraform"
  }
  description = "Tags applied to supported resources."
}
