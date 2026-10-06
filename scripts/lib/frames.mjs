// Messages between this process and the one that draws SVGs (svg.mjs and
// svg-worker.mjs): each is four bytes of length and then that many bytes.

export const frame = (bytes) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

// Collects what arrives on a pipe and hands back whole messages. The pieces
// are joined once, when a message is complete: joining on every piece would
// copy a 30 MB message hundreds of times over.
export class FrameReader {
  #chunks = [];
  #size = 0;

  push(chunk) {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
  }

  // The next whole message, or null while it is still arriving.
  take() {
    if (this.#size < 4) return null;
    while (this.#chunks[0].length < 4) this.#chunks.splice(0, 2, Buffer.concat(this.#chunks.slice(0, 2)));
    const length = this.#chunks[0].readUInt32BE(0);
    if (this.#size < 4 + length) return null;
    const all = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks, this.#size);
    const rest = all.subarray(4 + length);
    this.#chunks = rest.length ? [rest] : [];
    this.#size = rest.length;
    return all.subarray(4, 4 + length);
  }
}
