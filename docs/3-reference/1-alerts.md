# Alerts

Every box is checked for video and audio problems. The **Alerts** button turns red while anything is active and opens a side panel with the last five minutes of history, including how long each alert lasted. The panel leaves the wall usable; click an alert to jump to its box. Each alert can be switched off in **Settings → Alerts**, or hidden for one box with its eye button.

## Video

| Alert              | Threshold                                                            |
| ------------------ | -------------------------------------------------------------------- |
| Video buffering    | The player has too little future video data for 4 s.                 |
| Repeated buffering | 5 buffering starts within 60 s.                                      |
| Video frozen       | Playback time has not changed for 8 s. The alert clears after 1 min. |

## Audio

| Alert                | Threshold                                                                      |
| -------------------- | ------------------------------------------------------------------------------ |
| Audio silent         | Levels drop below -85 dB after audio was present. The alert lasts up to 1 min. |
| Audio dropouts       | 3 of the last 10 checks drop from signal to silence.                           |
| Audio clipping       | 5 peaks at 0 dBFS or above within 7 s.                                         |
| One channel missing  | One channel has signal while the other is below -85 dB for 15 s.               |
| Audio imbalance      | Both channels have signal but differ by 20 dB or more for 20 s.                |
| Audio phase mismatch | Stereo phase stays unsafe for mono playback for 10 s.                          |

Phase mismatch catches a feed whose left and right channels cancel each other in mono while looking and sounding fine in stereo. See [One faulty audio embedder disrupted 20 live streams](https://live-miracles.github.io/blog/one-faulty-embedder-20-streams/).

A new alert beeps once a second for up to 30 s. **Acknowledge** stops its beep sooner; the box stays red until the alert clears. The bell turns the beep on or off; hover it for a volume slider (0 to 500%). The button beside it switches the output between stereo and mono.
