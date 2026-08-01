import { Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";

/**
 * Reads a barcode, by camera where the browser can and by keyboard always.
 *
 * **Manual entry is first-class, not a fallback.** Camera access needs HTTPS or
 * localhost, a permission grant, and a barcode API the browser actually has —
 * three things that fail independently, and none of which should stand between
 * someone and putting shopping away. The text field is therefore always
 * present and always works; the camera is an accelerator on top of it.
 *
 * Not a Signal Form, deliberately. This is one string with no validation to
 * speak of — the server normalizes and validates the code, because it has to
 * anyway and doing it twice is how the two drift apart. A plain signal with
 * `[value]` and `(input)` is the right tool, the same call the ingredient
 * picker makes.
 */
@Component({
  selector: "app-barcode-scan",
  imports: [MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule],
  template: `
    <div class="scan">
      <mat-form-field appearance="outline" class="grow">
        <mat-label>{{ label() }}</mat-label>
        <input
          matInput
          [value]="text()"
          (input)="onType($any($event.target).value)"
          (keydown.enter)="submit($event)"
          inputmode="numeric"
          autocomplete="off"
          placeholder="Scan, or type the digits"
        />
        <mat-icon matSuffix>barcode_reader</mat-icon>
        <mat-hint>{{ hint() }}</mat-hint>
      </mat-form-field>

      <button
        mat-stroked-button
        type="button"
        (click)="submit($event)"
        [disabled]="!canSubmit()"
      >
        <mat-icon>search</mat-icon>
        Look up
      </button>

      @if (cameraSupported()) {
        <button mat-stroked-button type="button" (click)="toggleCamera()">
          <mat-icon>{{ scanning() ? "close" : "photo_camera" }}</mat-icon>
          {{ scanning() ? "Stop" : "Scan" }}
        </button>
      }
    </div>

    <!--
      Kept in the DOM rather than behind @if: the video element has to exist
      before the stream can be attached to it, and creating it in the same tick
      as starting the camera raced often enough to be a real bug.
    -->
    <div class="viewer" [class.flash]="justDetected()" [hidden]="!scanning()">
      <video #video playsinline muted></video>
      @if (justDetected()) {
        <div class="flash-badge" aria-hidden="true">
          <mat-icon>check_circle</mat-icon>
        </div>
      }
      <p class="muted small">Hold the barcode steady in the frame.</p>
    </div>

    @if (cameraError()) {
      <p class="warn-text small" role="alert">{{ cameraError() }}</p>
    }
  `,
  styles: `
    .scan { display: flex; gap: .5rem; align-items: flex-start; }
    .grow { flex: 1; }
    .small { font-size: .85rem; }
    .viewer { position: relative; margin-bottom: .5rem; }
    video {
      width: 100%;
      max-width: 24rem;
      border-radius: 8px;
      background: #000;
      outline: 4px solid transparent;
      transition: outline-color .1s ease-out;
    }
    /* A short outline flash + checkmark confirm a read without making anyone
       read text — the phone is usually pointed at a barcode, not the screen. */
    .viewer.flash video {
      outline-color: var(--mat-sys-primary);
    }
    .flash-badge {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      color: var(--mat-sys-primary);
    }
    .flash-badge mat-icon {
      font-size: 3rem;
      width: 3rem;
      height: 3rem;
      filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.6));
    }
  `,
})
export class BarcodeScanComponent {
  private readonly destroyRef = inject(DestroyRef);

  readonly label = input("Barcode");
  readonly hint = input("");

  /**
   * Keeps the camera running after a read instead of stopping it, for
   * scanning several items in one session. The caller is responsible for
   * de-duplicating what it does with each emission; this component only
   * suppresses the same code firing again while it's still in frame.
   */
  readonly continuous = input(false);

  /** A barcode the user has committed to, in whatever format they gave it. */
  readonly scanned = output<string>();

  readonly text = signal("");
  readonly scanning = signal(false);
  readonly cameraError = signal("");

  /** True for a moment after a camera read, for the outline flash + checkmark. */
  readonly justDetected = signal(false);
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>("video");

  /** Stops whichever reader is running. Set while scanning, null otherwise. */
  private stop: (() => void) | null = null;

  /** The last code read in continuous mode, and when — for the cooldown below. */
  private lastCode = "";
  private lastDetectedAt = 0;

  /** How long a code is ignored for after firing, so holding it in frame
   * doesn't queue it dozens of times a second. */
  private static readonly RESCAN_COOLDOWN_MS = 2000;

  /**
   * Whether a camera scan is worth offering at all.
   *
   * `mediaDevices` is absent on plain HTTP, so this is also what keeps the
   * button off the screen when the app is served without TLS — which would
   * otherwise offer a scan that can only fail on a permission error.
   */
  readonly cameraSupported = computed(
    () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
  );

  readonly canSubmit = computed(() => /\d/.test(this.text()));

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.stopCamera();
      if (this.flashTimer) clearTimeout(this.flashTimer);
    });
  }

  onType(value: string): void {
    this.text.set(value);
  }

  /**
   * Commits what is in the box.
   *
   * `preventDefault` matters: this component sits inside the pantry `<form>`,
   * and Enter in a text field submits the form it is in. Without this, typing a
   * barcode and pressing Enter would try to save a half-filled lot.
   */
  submit(event: Event): void {
    event.preventDefault();
    const code = this.text().trim();
    if (!code) return;
    this.scanned.emit(code);
  }

  /** Fills the box from a scan without emitting — used to show what was read. */
  setText(code: string): void {
    this.text.set(code);
  }

  toggleCamera(): void {
    if (this.scanning()) this.stopCamera();
    else void this.startCamera();
  }

  /**
   * Starts a camera scan, preferring the browser's own barcode reader.
   *
   * `BarcodeDetector` is hardware-accelerated where it exists (Chrome and
   * Android especially) and costs nothing to load. ZXing is the fallback for
   * everywhere else — notably Firefox and desktop Safari — and is imported
   * dynamically so its several hundred kilobytes stay out of the bundle for
   * everyone who never opens the camera.
   */
  private async startCamera(): Promise<void> {
    this.cameraError.set("");
    this.scanning.set(true);

    const video = this.video()?.nativeElement;
    if (!video) {
      this.failCamera("The camera view is not ready yet. Try again.");
      return;
    }

    try {
      if ("BarcodeDetector" in globalThis) {
        await this.startNativeScan(video);
      } else {
        await this.startZxingScan(video);
      }
    } catch (error: unknown) {
      this.failCamera(this.cameraMessage(error));
    }
  }

  /** The browser's own detector, polled against a plain `getUserMedia` stream. */
  private async startNativeScan(video: HTMLVideoElement): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });

    video.srcObject = stream;
    await video.play();

    type Detector = {
      detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
    };
    const Ctor = (globalThis as unknown as {
      BarcodeDetector: new (options: { formats: string[] }) => Detector;
    }).BarcodeDetector;

    const detector = new Ctor({
      formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
    });

    let cancelled = false;
    const timer = setInterval(() => {
      if (cancelled) return;
      void detector
        .detect(video)
        .then((results) => {
          const code = results[0]?.rawValue;
          if (code) this.onDetected(code);
        })
        // A frame that cannot be decoded is the normal case between reads, not
        // an error worth showing anybody.
        .catch(() => undefined);
    }, 300);

    this.stop = () => {
      cancelled = true;
      clearInterval(timer);
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    };
  }

  /** ZXing, loaded only when the browser has no detector of its own. */
  private async startZxingScan(video: HTMLVideoElement): Promise<void> {
    const { BrowserMultiFormatReader } = await import("@zxing/browser");
    const reader = new BrowserMultiFormatReader();

    const controls = await reader.decodeFromVideoDevice(
      undefined,
      video,
      (result) => {
        if (result) this.onDetected(result.getText());
      },
    );

    this.stop = () => controls.stop();
  }

  /**
   * A successful read.
   *
   * Non-continuous (the default): stops the camera first — leaving it running
   * would keep firing on the same barcode, re-emitting it several times a
   * second.
   *
   * Continuous: the camera keeps running for the next item, so the same
   * cooldown is enforced here instead, keyed on the code itself rather than
   * "any recent read" — moving straight from one barcode to a different one
   * should not be held up by the first one's cooldown.
   */
  private onDetected(code: string): void {
    if (this.continuous()) {
      const now = Date.now();
      if (
        code === this.lastCode &&
        now - this.lastDetectedAt < BarcodeScanComponent.RESCAN_COOLDOWN_MS
      ) {
        return;
      }
      this.lastCode = code;
      this.lastDetectedAt = now;
      this.flash();
      this.text.set("");
      this.scanned.emit(code);
      return;
    }

    // Not `flash()`: stopCamera() below hides the viewer this tick, so a
    // flash timed for it would never be seen.
    this.stopCamera();
    this.text.set(code);
    this.scanned.emit(code);
  }

  /**
   * A moment of outline + checkmark + (where supported) a short vibration —
   * confirmation that doesn't depend on reading the screen, since the phone
   * is pointed at the item being scanned, not held up to be looked at.
   */
  private flash(): void {
    navigator.vibrate?.(60);
    this.justDetected.set(true);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.justDetected.set(false), 400);
  }

  private stopCamera(): void {
    this.stop?.();
    this.stop = null;
    this.scanning.set(false);
  }

  private failCamera(message: string): void {
    this.stopCamera();
    this.cameraError.set(message);
  }

  /**
   * Says what actually went wrong, because the remedies differ completely: a
   * refused permission is fixed in the browser's site settings, and no camera
   * at all is not fixable and should send the user to the text field.
   */
  private cameraMessage(error: unknown): string {
    const name = (error as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "Camera access was refused. Allow it in your browser's site settings, or type the digits instead.";
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return "No camera was found. Type the digits instead.";
    }
    return "The camera could not be started. Type the digits instead.";
  }
}
