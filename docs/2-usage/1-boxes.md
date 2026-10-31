# Boxes

A box is one source with its own player, audio meter and alerts. Drag a box by its grip to reorder it.

## Sources

- YouTube, including privacy-enhanced `youtube-nocookie` links
- JW Player (set the **JW server host** in **Settings** if you use your own) and VdoCipher
- HLS (`.m3u8`) and other embeddable pages, as custom URLs
- Local audio or video files
- Screen shares with a chosen audio input, which also covers [Zoom and other desktop apps](5-monitor-zoom.md)

## Box status

The dot beside each box's name is green only while its playback time is moving. Otherwise the name says why:

- **Starting…**: the player has had less than 20 s to start.
- **Not playing**: the page has a player, but it is paused, stuck or showing an error such as YouTube's "Video unavailable".
- **No video**: no player appeared within 20 s.
- **Load failed**: the page itself could not load.

A red box has an active [alert](../3-reference/1-alerts.md). The box you are hearing has a cyan outline and a speaker beside its name.

The toolbar counts the wall by these states. Click a count other than **live** to jump to the next box it counts.

## Worth knowing

- The eye button hides alerts for one box, for example a feed you know is down.
- The copy button copies the box's URL.
- Expand fills the window below the toolbar, so the status counts stay in view; press **Esc** to go back.
- A removed box can be restored with **Undo** for 8 s.

## Sizing

- **Box size** (`-` and `+` in the toolbar, or the [shortcuts](../3-reference/2-shortcuts.md)) goes up to 1000%.
- **Interface size** in **Settings → Accessibility** scales the whole window, from 75% to 200%.

The app reopens on the same display, position and full-screen state.
