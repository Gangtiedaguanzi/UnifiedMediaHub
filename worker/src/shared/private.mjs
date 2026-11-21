import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod } from "node:fs/promises";
import { safeDirectory, rejectLinks } from "./paths.mjs";
const run = promisify(execFile);
export async function securePrivateRoot(dataRoot) {
  const root = path.join(dataRoot, "private");
  await safeDirectory(root);
  if (process.platform === "win32") {
    // PowerShell uses a literal argument path, never interpolated command text. Replace the
    // complete DACL, so unexpected explicit entries cannot survive a prior insecure setup.
    const script =
      '$ErrorActionPreference="Stop"; $p=$args[0]; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $prior=[System.IO.Directory]::GetAccessControl($p); if($prior.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw "owner mismatch"}; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $allowed=@($sid.Value,"S-1-5-18","S-1-5-32-544"); foreach($s in $allowed){ $r=New-Object System.Security.AccessControl.FileSystemAccessRule(([System.Security.Principal.SecurityIdentifier]::new($s)),"FullControl","ContainerInherit,ObjectInherit","None","Allow"); $acl.AddAccessRule($r) }; [System.IO.Directory]::SetAccessControl($p,$acl); $check=[System.IO.Directory]::GetAccessControl($p); if($check.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $check.AreAccessRulesProtected){throw "acl mismatch"}; $rules=@($check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); if($rules.Count -ne 3){throw "acl mismatch"}; foreach($r in $rules){if($r.IdentityReference.Value -notin $allowed -or $r.AccessControlType -ne "Allow" -or $r.IsInherited -or [int]$r.FileSystemRights -ne 2032127 -or [int]$r.InheritanceFlags -ne 3 -or [int]$r.PropagationFlags -ne 0){throw "acl mismatch"}}';
    // EncodedCommand does not accept trailing positional arguments on Windows PowerShell;
    // supply only the validated path via an isolated environment variable.
    const actual = script.replace(
      "$p=$args[0]",
      "$p=$env:UMH_PRIVATE_ACL_TARGET",
    );
    await run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(actual, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 4096,
        env: { ...process.env, UMH_PRIVATE_ACL_TARGET: root },
      },
    ).catch(() => {
      throw new Error("private_acl_failed");
    });
  } else await chmod(root, 0o700);
  await rejectLinks(root);
  return root;
}
