import type { ServerInfo } from '../api/client';
import { REPO_URL } from '../config';

export function HowItWorks({ info }: { info: ServerInfo }) {
  return (
    <details className="panel how">
      <summary>
        <h2 className="how-title">How it works</h2>
      </summary>
      <ol className="how-list">
        <li>
          <h3>
            Is it a photograph? <span className="tag">{info.models.classifier}</span>
          </h3>
          <p>
            A compact image classifier sorts the picture into five kinds: painting, photo,
            schematic, sketch or text. The captioning model only learned from photographs, so other
            kinds of image stop here.
          </p>
        </li>
        <li>
          <h3>
            Is it clean? <span className="tag">U-Net {info.models.denoiser}</span>
          </h3>
          <p>
            Two quick measurements estimate the amount of noise (grain) and the sharpness. If the
            image is noisy or blurry, a U-Net, a network that compresses then rebuilds the image,
            produces a cleaner version. If the first check said “not a photo”, the cleaned image is
            checked again, because heavy noise can make a photo look like a painting.
          </p>
        </li>
        <li>
          <h3>
            Describe it <span className="tag">{info.models.captioner}</span>
          </h3>
          <p>
            A convolutional network turns the image into features, then a recurrent network writes a
            sentence one word at a time. Beam search keeps the three most promising sentences at
            each word; greedy decoding keeps only the best one, which is faster but less fluent.
          </p>
        </li>
      </ol>
      {REPO_URL ? (
        <p>
          More details, including the API contract, in the{' '}
          <a href={REPO_URL} rel="noreferrer">
            project README
          </a>
          .
        </p>
      ) : (
        <p>More details, including the API contract, are in the project README.</p>
      )}
    </details>
  );
}
