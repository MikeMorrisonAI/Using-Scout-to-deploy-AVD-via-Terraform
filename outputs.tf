output "resource_group_name" {
  description = "Resource group containing the AVD starter deployment."
  value       = azurerm_resource_group.avd.name
}

output "host_pool_name" {
  description = "Azure Virtual Desktop host pool name."
  value       = azurerm_virtual_desktop_host_pool.avd.name
}

output "workspace_name" {
  description = "Azure Virtual Desktop workspace name."
  value       = azurerm_virtual_desktop_workspace.avd.name
}

output "desktop_application_group_name" {
  description = "Desktop application group name."
  value       = azurerm_virtual_desktop_application_group.desktop.name
}

output "session_host_names" {
  description = "Session host VM names."
  value       = keys(azurerm_windows_virtual_machine.session_host)
}

output "generated_local_admin_username" {
  description = "Generated local administrator username."
  value       = var.local_admin_username
}

output "generated_local_admin_password" {
  description = "Generated local administrator password. Retrieve with: terraform output -raw generated_local_admin_password"
  value       = random_password.local_admin.result
  sensitive   = true
}
