// Configure only after the canonical repository and release URL are confirmed.
const releaseDownloadUrl = "https://github.com/krnrohan/Panda-AI-Companion/releases/download/v0.1.0/Panda.Companion_0.1.0_x64-setup.exe"; // Set only to the verified Windows installer asset URL after a tested release.
const button = document.getElementById("download");
if (button && releaseDownloadUrl) {
  button.disabled = false;
  button.textContent = "Download for Windows";
  button.addEventListener("click", () => { window.location.href = releaseDownloadUrl; });
} else if (button) {
  button.disabled = true;
  button.setAttribute("aria-disabled", "true");
}
