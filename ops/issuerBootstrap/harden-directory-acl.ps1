#Requires -Version 5.1
<#
.SYNOPSIS
  SEC-001 Packet C-A — hardens filesystem ACLs on a local directory used by
  the Admin Issuance Console for sensitive local material (exported enrollment
  files, local key backups). Restricts access to the current user only:
  disables inheritance, strips inherited/broad grants, and applies a single
  explicit FullControl ACE scoped "this folder, subfolders and files"
  (InheritanceFlags = ContainerInherit,ObjectInherit; PropagationFlags = None).

.PARAMETER TargetDirectory
  Path to an existing directory to harden. The script does not create
  directories — Ops/the console is expected to create the directory first.

.OUTPUTS
  A single-line JSON object on stdout describing the resulting ACL, so
  automated tests (and Ops) can verify the outcome structurally rather than
  by parsing icacls text output.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetDirectory
)

$ErrorActionPreference = 'Stop'

function Write-JsonResult {
    param([hashtable]$Result)
    $json = $Result | ConvertTo-Json -Depth 6 -Compress
    Write-Output $json
}

if (-not (Test-Path -LiteralPath $TargetDirectory -PathType Container)) {
    Write-JsonResult @{
        success         = $false
        targetDirectory = $TargetDirectory
        error           = 'target_directory_not_found'
    }
    exit 1
}

$resolvedPath = (Resolve-Path -LiteralPath $TargetDirectory).ProviderPath
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $currentIdentity.User

try {
    $acl = Get-Acl -LiteralPath $resolvedPath

    # Disable inheritance and strip every existing inherited rule; then remove
    # any remaining explicit rules so the directory starts from a clean slate.
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
        [void]$acl.RemoveAccessRule($rule)
    }

    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $inheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagationFlags = [System.Security.AccessControl.PropagationFlags]::None
    $accessControlType = [System.Security.AccessControl.AccessControlType]::Allow

    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $currentSid, $rights, $inheritanceFlags, $propagationFlags, $accessControlType
    )
    $acl.AddAccessRule($rule)
    $acl.SetOwner($currentSid)

    Set-Acl -LiteralPath $resolvedPath -AclObject $acl

    # Re-read to report the *actual* resulting state, not the in-memory object.
    $finalAcl = Get-Acl -LiteralPath $resolvedPath
    $finalRules = @($finalAcl.Access | ForEach-Object {
        @{
            identity          = $_.IdentityReference.Value
            fileSystemRights  = $_.FileSystemRights.ToString()
            inheritanceFlags  = $_.InheritanceFlags.ToString()
            propagationFlags  = $_.PropagationFlags.ToString()
            accessControlType = $_.AccessControlType.ToString()
            isInherited       = $_.IsInherited
        }
    })

    Write-JsonResult @{
        success          = $true
        targetDirectory  = $resolvedPath
        owner            = $finalAcl.Owner
        areAccessRulesProtected = $finalAcl.AreAccessRulesProtected
        rules            = $finalRules
    }
    exit 0
}
catch {
    Write-JsonResult @{
        success         = $false
        targetDirectory = $resolvedPath
        error           = $_.Exception.Message
    }
    exit 1
}
