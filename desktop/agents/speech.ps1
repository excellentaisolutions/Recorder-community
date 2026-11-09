param([Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$options = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($options.action -eq 'voices') {
    $voices = @($speech.GetInstalledVoices() | Where-Object Enabled | ForEach-Object {
      @{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name; gender = [string]$_.VoiceInfo.Gender }
    })
    ConvertTo-Json -InputObject $voices -Compress
  } else {
    if ($options.voice) { $speech.SelectVoice($options.voice) }
    else {
      $spanish = $speech.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'es-*' } | Select-Object -First 1
      if ($spanish) { $speech.SelectVoice($spanish.VoiceInfo.Name) }
    }
    $speech.Rate = $options.rate
    $speech.SetOutputToWaveFile($options.output)
    $speech.Speak($options.text)
    @{ voice = $speech.Voice.Name; culture = $speech.Voice.Culture.Name } | ConvertTo-Json -Compress
  }
} finally { $speech.Dispose() }
