import { useEffect, useRef, useState } from "react";

/** A photo ready to upload: the JPEG and a data: URL to preview it (the page's CSP allows data: images). */
export interface Photo {
  blob: Blob;
  preview: string;
}

const MAX_SIDE = 1280;

/** Draws an image (camera frame or chosen file) at most 1280 px on its long side, as a JPEG of ~150–250 KB. */
function toPhoto(source: CanvasImageSource, width: number, height: number): Promise<Photo> {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve({ blob, preview: canvas.toDataURL("image/jpeg", 0.8) }) : reject(new Error("no image"))),
      "image/jpeg",
      0.8,
    ),
  );
}

/**
 * One photo: live camera → Capture → ✓ use it / ✗ take again. Where the browser gives no live camera (a plain-http
 * address on the LAN, or no camera allowed), "Take with phone camera" opens the device's own camera app instead.
 */
export function CameraCapture({ title, onDone, onCancel }: { title: string; onDone: (p: Photo) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [shot, setShot] = useState<Photo | null>(null);
  const [problem, setProblem] = useState("");
  const live = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;

  // The live camera runs only while no photo is waiting for ✓ / ✗, and always stops when the dialog closes.
  useEffect(() => {
    if (!live || shot) return;
    let cancelled = false;
    let opened: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: MAX_SIDE } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        opened = s;
        setStream(s);
      })
      .catch(() => setProblem("The camera could not be opened — allow camera access, or take the photo with the phone camera."));
    return () => {
      cancelled = true;
      opened?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
  }, [live, shot]);

  useEffect(() => {
    if (video.current && stream) {
      video.current.srcObject = stream;
      void video.current.play().catch(() => undefined);
    }
  }, [stream]);

  async function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    setShot(await toPhoto(v, v.videoWidth, v.videoHeight));
  }

  function fromFile(f: File | undefined) {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => void toPhoto(img, img.naturalWidth, img.naturalHeight).then(setShot, () => setProblem("That file is not a photo."));
      img.onerror = () => setProblem("That file is not a photo.");
      img.src = String(reader.result);
    };
    reader.readAsDataURL(f);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-[560px] rounded-[6px] border border-rule bg-card shadow-lg">
        <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
          <h2 className="text-[14px] font-bold">{title}</h2>
          <button className="btn h-7 px-2 text-[12px]" onClick={onCancel} aria-label="Close without a photo">
            Cancel
          </button>
        </div>
        <div className="space-y-3 p-4">
          <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded bg-ink">
            {shot ? (
              <img src={shot.preview} alt="The photo just taken" className="h-full w-full object-contain" />
            ) : live && !problem ? (
              <video ref={video} playsInline muted className="h-full w-full object-contain" />
            ) : (
              <p className="px-6 text-center text-[12.5px] text-white/80">
                {problem || "This address gives no live camera — use the phone camera below."}
              </p>
            )}
          </div>
          <input
            ref={file}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              fromFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {shot ? (
            <div className="flex gap-2">
              <button className="btn btn-primary flex-1 justify-center" onClick={() => onDone(shot)}>
                ✓ Use this photo
              </button>
              <button className="btn flex-1 justify-center" onClick={() => setShot(null)}>
                ✗ Take again
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              {live && !problem && (
                <button className="btn btn-primary flex-1 justify-center" onClick={() => void capture()} disabled={!stream}>
                  Capture
                </button>
              )}
              <button className="btn flex-1 justify-center" onClick={() => file.current?.click()}>
                Take with phone camera
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A stored gate photo, full size, on top of the page. */
export function PhotoViewer({ gateEntryId, onClose }: { gateEntryId: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4" role="dialog" aria-modal="true" aria-label={`Photo of ${gateEntryId}`} onClick={onClose}>
      <div className="max-h-full max-w-[900px] rounded-[6px] bg-card p-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-1 pb-2">
          <span className="num text-[13px] font-bold">{gateEntryId}</span>
          <button className="btn h-7 px-2 text-[12px]" onClick={onClose}>
            Close
          </button>
        </div>
        <img src={`/api/gate-entries/${encodeURIComponent(gateEntryId)}/photo`} alt={`Gate photo of ${gateEntryId}`} className="max-h-[80vh] w-auto rounded" />
      </div>
    </div>
  );
}
