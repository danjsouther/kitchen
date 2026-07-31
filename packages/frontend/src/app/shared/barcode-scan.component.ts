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
    <div class="viewer" [hidden]="!scanning()">
      <video #video playsinline muted></video>
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
    .viewer { margin-bottom: .5rem; }
    video {
      width: 100%;
      max-width: 24rem;
      border-radius: 8px;
      background: #000;
    }
  `,
})
export class BarcodeScanComponent {
  private readonly destroyRef = inject(DestroyRef);

  readonly label = input("Barcode");
  readonly hint = input("");

  /** A barcode the user has committed to, in whatever format they gave it. */
  readonly scanned = output<string>();

  readonly text = signal("");
  readonly scanning = signal(false);
  readonly cameraError = signal("");

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>("video");

  /** Stops whichever reader is running. Set while scanning, null otherwise. */
  private stop: (() => void) | null = null;

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
    this.destroyRef.onDestroy(() => this.stopCamera());
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
   * A successful read. Stops the camera first — leaving it running would keep
   * firing on the same barcode, re-emitting it several times a second.
   */
  private onDetected(code: string): void {
    this.stopCamera();
    this.text.set(code);
    this.scanned.emit(code);
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
