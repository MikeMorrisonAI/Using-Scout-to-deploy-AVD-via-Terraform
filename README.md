# Using-Scout-to-deploy-AVD-via-Terraform

This project was created in Microsoft Scout. It provisioned a Terraform-based Azure Virtual Desktop starter environment for the Arrow subscription. The build creates a one-node pooled AVD deployment with a Windows 11 Enterprise multi-session host, Entra ID join, AVD workspace, desktop application group, host pool registration, networking, NSG rules, and optional role assignments for user access.

The project uses AzureRM, Random, and Time providers. Deployment flow is: authenticate with Azure CLI, select the target subscription, initialize Terraform, validate the configuration, generate a plan, and apply it. Sensitive runtime artifacts such as Terraform state, plans, generated passwords, local variable files, and provider cache directories are excluded from Git.
