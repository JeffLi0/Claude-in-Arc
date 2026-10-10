/**
 * Arc Bridge Name — makes a new browser name show up right away.
 *
 * Each Arc profile runs its own copy of the extension, so Claude lists several
 * browsers, and naming them is how you tell them apart. Upstream sends the
 * name only in the bridge's "connect" message, though, so a name given in the
 * "wants to connect" prompt is saved but the open connection keeps listing the
 * old one ("Browser 1") until it happens to reconnect. Reconnect when the name
 * changes, the way upstream does when the network comes back.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('bridgeDisplayName' in changes)) return;
  // Give the pairing reply that carried the new name time to go out first.
  setTimeout(() => {
    const ws = self._arcBridgeWS;
    if (ws?.readyState === WebSocket.OPEN) ws.close(4002, 'display-name-changed');
  }, 1500);
});
