import { useEffect, useRef, useState, type RefObject } from "react";
import { Maximize, Pause, Play } from "lucide-react";

type Props = {
  url: string; audio: RefObject<HTMLAudioElement>; playing: boolean;
  toggle(): void; onError(message: string): void;
};

// One audio clock keeps both playback modes in step with the app's transport.
export function YouTubePlayer(props: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [fullscreenError, setFullscreenError] = useState("");
  const latest = useRef(props); latest.current = props;
  useEffect(() => {
    const picture = video.current; const sound = props.audio.current;
    if (!picture || !sound || !props.url) return;
    let disposed = false;
    const sync = () => {
      if (disposed || picture.readyState < 2) return;
      if (!picture.seeking && Math.abs(picture.currentTime - sound.currentTime) > .3) picture.currentTime = sound.currentTime;
      picture.playbackRate = sound.playbackRate;
      if (sound.paused || sound.ended || sound.readyState < 3) picture.pause();
      else if (picture.paused) void picture.play().catch(error => {
        if (!disposed && error.name !== "AbortError") latest.current.onError("Video could not start. Retry the video source.");
      });
    };
    picture.muted = true; picture.src = props.url; picture.load();
    const events = ["playing", "pause", "waiting", "seeking", "seeked", "ratechange", "ended"];
    events.forEach(event => sound.addEventListener(event, sync));
    picture.addEventListener("canplay", sync);
    const interval = setInterval(sync, 200);
    return () => {
      disposed = true; clearInterval(interval);
      events.forEach(event => sound.removeEventListener(event, sync));
      picture.removeEventListener("canplay", sync);
      picture.pause(); picture.removeAttribute("src"); picture.load();
    };
  }, [props.url, props.audio]);
  const fullscreen = () => {
    setFullscreenError("");
    const change = document.fullscreenElement ? document.exitFullscreen() : container.current?.requestFullscreen();
    void change?.catch(() => setFullscreenError("Click the player and retry fullscreen."));
  };
  return <div ref={container} className="youtube-frame native-video" aria-label="YouTube video player" onDoubleClick={fullscreen}>
    <video ref={video} muted playsInline preload="auto" onClick={props.toggle}
      onError={() => { if (latest.current.url && video.current?.getAttribute("src")) latest.current.onError("Video could not be loaded or decoded. Retry the video source."); }} />
    {!props.url && <span className="video-loading">Connecting video…</span>}
    {fullscreenError && <span className="video-loading" role="status">{fullscreenError}</span>}
    <div className="video-actions"><button className="icon-button" aria-label={props.playing ? "Pause video" : "Play video"} onClick={props.toggle}>{props.playing ? <Pause size={20} /> : <Play size={20} />}</button><button className="icon-button" aria-label="Toggle video fullscreen" onClick={fullscreen}><Maximize size={20} /></button></div>
  </div>;
}
