// Messages between this process and the ones that work for it (the one that
// checks a file: checker.mjs and check-worker.mjs; the one that draws SVGs:
// svg.mjs and svg-worker.mjs): each is four bytes of length and then that many
// bytes.

const lengthOf = (bytes) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return length;
};

export const frame = (bytes) => Buffer.concat([lengthOf(bytes), bytes]);

// Writes messages to a pipe, each as its length and then its bytes as they
// are: a file of 200 MB is not copied to have four bytes put in front of it.
// `done` is called when the last has been handed over.
export const writeFrames = (pipe, messages, done) => {
  messages.forEach((bytes, index) => {
    pipe.write(lengthOf(bytes));
    pipe.write(bytes, index === messages.length - 1 ? done : undefined);
  });
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
