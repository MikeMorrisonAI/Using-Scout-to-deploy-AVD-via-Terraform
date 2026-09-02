locals {
  name_prefix = lower(replace(var.name_prefix, "/[^a-zA-Z0-9-]/", ""))
  session_hosts = {
    for index in range(var.session_host_count) :
    format("%s-%02d", local.name_prefix, index + 1) => index + 1
  }
}

resource "azurerm_resource_group" "avd" {
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

resource "azurerm_virtual_network" "avd" {
  name                = "${local.name_prefix}-vnet"
  address_space       = [var.vnet_address_space]
  location            = azurerm_resource_group.avd.location
  resource_group_name = azurerm_resource_group.avd.name
  tags                = var.tags
}

resource "azurerm_subnet" "session_hosts" {
  name                 = "${local.name_prefix}-session-hosts-snet"
  resource_group_name  = azurerm_resource_group.avd.name
  virtual_network_name = azurerm_virtual_network.avd.name
  address_prefixes     = [var.session_host_subnet_prefix]
}

resource "azurerm_network_security_group" "session_hosts" {
  name                = "${local.name_prefix}-session-hosts-nsg"
  location            = azurerm_resource_group.avd.location
  resource_group_name = azurerm_resource_group.avd.name
  tags                = var.tags
}

resource "azurerm_network_security_rule" "allow_rdp_from_local_ip" {
  count = var.rdp_source_address_prefix == null ? 0 : 1

  name                        = "Allow-RDP-From-Local-IP"
  priority                    = 1000
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "3389"
  source_address_prefix       = var.rdp_source_address_prefix
  destination_address_prefix  = "*"
  resource_group_name         = azurerm_resource_group.avd.name
  network_security_group_name = azurerm_network_security_group.session_hosts.name
}

resource "azurerm_subnet_network_security_group_association" "session_hosts" {
  subnet_id                 = azurerm_subnet.session_hosts.id
  network_security_group_id = azurerm_network_security_group.session_hosts.id
}

resource "azurerm_virtual_desktop_host_pool" "avd" {
  name                     = "${local.name_prefix}-hp"
  location                 = azurerm_resource_group.avd.location
  resource_group_name      = azurerm_resource_group.avd.name
  type                     = "Pooled"
  load_balancer_type       = "BreadthFirst"
  maximum_sessions_allowed = var.maximum_sessions_allowed
  start_vm_on_connect      = true
  friendly_name            = "${var.name_prefix} pooled host pool"
  description              = "Starter Azure Virtual Desktop host pool with ${var.session_host_count} session host."
  custom_rdp_properties    = "targetisaadjoined:i:1;enablerdsaadauth:i:1;audiocapturemode:i:1;audiomode:i:0;"
  tags                     = var.tags
}

resource "time_rotating" "registration_token" {
  rotation_days = 1
}

resource "azurerm_virtual_desktop_host_pool_registration_info" "avd" {
  hostpool_id     = azurerm_virtual_desktop_host_pool.avd.id
  expiration_date = timeadd(time_rotating.registration_token.rfc3339, "48h")
}

resource "azurerm_virtual_desktop_workspace" "avd" {
  name                = "${local.name_prefix}-workspace"
  location            = azurerm_resource_group.avd.location
  resource_group_name = azurerm_resource_group.avd.name
  friendly_name       = "${var.name_prefix} workspace"
  description         = "Starter Azure Virtual Desktop workspace."
  tags                = var.tags
}

resource "azurerm_virtual_desktop_application_group" "desktop" {
  name                = "${local.name_prefix}-dag"
  location            = azurerm_resource_group.avd.location
  resource_group_name = azurerm_resource_group.avd.name
  type                = "Desktop"
  host_pool_id        = azurerm_virtual_desktop_host_pool.avd.id
  friendly_name       = "${var.name_prefix} desktop"
  description         = "Desktop application group for the starter AVD host pool."
  tags                = var.tags
}

resource "azurerm_virtual_desktop_workspace_application_group_association" "desktop" {
  workspace_id         = azurerm_virtual_desktop_workspace.avd.id
  application_group_id = azurerm_virtual_desktop_application_group.desktop.id
}

resource "azurerm_role_assignment" "desktop_users" {
  for_each             = toset(var.avd_user_object_ids)
  scope                = azurerm_virtual_desktop_application_group.desktop.id
  role_definition_name = "Desktop Virtualization User"
  principal_id         = each.value
}

resource "azurerm_role_assignment" "vm_users" {
  for_each             = toset(var.avd_user_object_ids)
  scope                = azurerm_resource_group.avd.id
  role_definition_name = "Virtual Machine User Login"
  principal_id         = each.value
}

resource "azurerm_role_assignment" "vm_admins" {
  for_each             = toset(var.avd_admin_object_ids)
  scope                = azurerm_resource_group.avd.id
  role_definition_name = "Virtual Machine Administrator Login"
  principal_id         = each.value
}

resource "random_password" "local_admin" {
  length           = 24
  special          = true
  min_lower        = 2
  min_numeric      = 2
  min_special      = 2
  min_upper        = 2
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "azurerm_network_interface" "session_host" {
  for_each            = local.session_hosts
  name                = "${each.key}-nic"
  location            = azurerm_resource_group.avd.location
  resource_group_name = azurerm_resource_group.avd.name
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.session_hosts.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_windows_virtual_machine" "session_host" {
  for_each              = local.session_hosts
  name                  = each.key
  computer_name         = replace(each.key, "-", "")
  location              = azurerm_resource_group.avd.location
  resource_group_name   = azurerm_resource_group.avd.name
  size                  = var.vm_size
  admin_username        = var.local_admin_username
  admin_password        = random_password.local_admin.result
  network_interface_ids = [azurerm_network_interface.session_host[each.key].id]
  provision_vm_agent    = true
  license_type          = "Windows_Client"
  tags                  = var.tags

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = var.os_disk_storage_account_type
  }

  source_image_reference {
    publisher = "MicrosoftWindowsDesktop"
    offer     = "windows-11"
    sku       = var.session_host_image_sku
    version   = "latest"
  }

  identity {
    type = "SystemAssigned"
  }
}

resource "azurerm_virtual_machine_extension" "entra_join" {
  for_each                   = azurerm_windows_virtual_machine.session_host
  name                       = "AADLoginForWindows"
  virtual_machine_id         = each.value.id
  publisher                  = "Microsoft.Azure.ActiveDirectory"
  type                       = "AADLoginForWindows"
  type_handler_version       = "1.0"
  auto_upgrade_minor_version = true
}

resource "azurerm_virtual_machine_extension" "avd_registration" {
  for_each                   = azurerm_windows_virtual_machine.session_host
  name                       = "AVDSessionHostRegistration"
  virtual_machine_id         = each.value.id
  publisher                  = "Microsoft.Powershell"
  type                       = "DSC"
  type_handler_version       = "2.83"
  auto_upgrade_minor_version = true

  settings = jsonencode({
    modulesUrl            = "https://wvdportalstorageblob.blob.core.windows.net/galleryartifacts/Configuration_1.0.03419.1309.zip"
    configurationFunction = "Configuration.ps1\\AddSessionHost"
    properties = {
      HostPoolName             = azurerm_virtual_desktop_host_pool.avd.name
      UseAgentDownloadEndpoint = true
    }
  })

  protected_settings = jsonencode({
    properties = {
      registrationInfoToken = azurerm_virtual_desktop_host_pool_registration_info.avd.token
    }
  })

  depends_on = [
    azurerm_virtual_machine_extension.entra_join
  ]
}
