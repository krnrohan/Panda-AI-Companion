// Configure only after the canonical repository and release URL are confirmed.
const releaseDownloadUrl = ""; // Set only to the verified Windows installer asset URL after a tested release.
const button = document.getElementById("download");
if (button && releaseDownloadUrl) {
  button.disabled = false;
  button.textContent = "Download for Windows";
  button.addEventListener("click", () => { window.location.href = releaseDownloadUrl; });
} else if (button) {
  button.disabled = true;
  button.setAttribute("aria-disabled", "true");
}
