# Sends one request file to TallyPrime and saves Tally's answer next to it (<name>.response.xml).
#   powershell -ExecutionPolicy Bypass -File docs\tally-queries\run.ps1 docs\tally-queries\02-vendors.xml
# Files 01-05 only read (Export). 06 CREATES a Purchase Order — run it on a test copy of Tally only.
param([Parameter(Mandatory = $true)][string]$Query, [string]$Url = "http://localhost:9000")
if (-not (Test-Path $Query)) { throw "No such file: $Query - check the name (files are 01-... to 06-..., with dashes)." }
$out = [IO.Path]::ChangeExtension($Query, ".response.xml")
$watch = [Diagnostics.Stopwatch]::StartNew()
curl.exe -s -X POST $Url -H "Content-Type: text/xml" --data-binary "@$Query" -o $out
if ($LASTEXITCODE -ne 0) { throw "Tally does not answer at $Url - is TallyPrime open with the company loaded?" }
$xml = [IO.File]::ReadAllText((Resolve-Path $out))
foreach ($tag in "STOCKITEM", "LEDGER", "VOUCHER") {
  $n = ([regex]::Matches($xml, "<$tag ")).Count
  if ($n) { "{0}: {1} record(s)" -f $tag, $n }
}
if ($xml -match "<CREATED>(\d+)</CREATED>") { "Created: $($Matches[1])" }
"Answer saved to $out ($([math]::Round($xml.Length / 1KB)) KB, $($watch.ElapsedMilliseconds) ms)"
