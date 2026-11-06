# Open Historia translation models

Translation models the Open Historia game downloads to translate itself on the player's device, for languages no one had published a Transformers.js copy for. The game reads them from this branch only.

Each model sits in `models/<name>/` in the layout Transformers.js reads: `config.json`, `generation_config.json`, `tokenizer.json`, `tokenizer_config.json` and the int8 `onnx/encoder_model_quantized.onnx` and `onnx/decoder_model_merged_quantized.onnx`. The game reads them through `https://raw.githubusercontent.com/Open-Historia/Open-historia-scenarios/<commit>/models/<name>/<file>` at a pinned commit, so a file it has kept never changes under it.

## Source and licence

These are [OPUS-MT](https://github.com/Helsinki-NLP/Opus-MT) models by the Language Technology Research Group at the University of Helsinki (Helsinki-NLP), trained on the [OPUS](https://opus.nlpl.eu/) corpus collection: Jörg Tiedemann and Santhosh Thottingal, "OPUS-MT — Building open translation services for the World", EAMT 2020. The OPUS-MT project releases its models under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); each Hugging Face repository below states its own licence, given in the table.

Each was exported from Helsinki-NLP's PyTorch weights to ONNX with Hugging Face Optimum, quantized to int8 with ONNX Runtime (dynamic quantization), and given a `tokenizer.json` built from the model's own SentencePiece model and vocabulary. A model that writes several languages is told which by the token shown.

| Folder | Converted from | Revision | Used for | Licence | Size |
|---|---|---|---|---|---|
| `models/opus-mt-en-bat` | [Helsinki-NLP/opus-mt-en-bat](https://huggingface.co/Helsinki-NLP/opus-mt-en-bat) | `25dcda35adeb25b398324bc032530e029e55c8d4` | Latvian (`>>lav<<`), Lithuanian (`>>lit<<`) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | 138.6 MB |
| `models/opus-mt-en-sk` | [Helsinki-NLP/opus-mt-en-sk](https://huggingface.co/Helsinki-NLP/opus-mt-en-sk) | `04d19ccd4566720bceeff93623d5cf93be659816` | Slovak | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | 140.1 MB |
| `models/opus-mt-en-et` | [Helsinki-NLP/opus-mt-en-et](https://huggingface.co/Helsinki-NLP/opus-mt-en-et) | `624b0dc8ad8f4a620ebb6331f06bc47937471f08` | Estonian | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | 138.3 MB |
| `models/opus-mt-en-el` | [Helsinki-NLP/opus-mt-en-el](https://huggingface.co/Helsinki-NLP/opus-mt-en-el) | `1653673990e6f1e3baf0a903f38e231730704444` | Greek | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | 147.8 MB |
| `models/opus-mt-en-he` | [Helsinki-NLP/opus-mt-en-he](https://huggingface.co/Helsinki-NLP/opus-mt-en-he) | `b3df900afbb13bc343b0d28a03ac6f7990091f54` | Hebrew | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | 149.3 MB |
| `models/opus-mt-en-ga` | [Helsinki-NLP/opus-mt-en-ga](https://huggingface.co/Helsinki-NLP/opus-mt-en-ga) | `10337fc4a7a24e2ac0c7443b1dca3ed187207d0d` | Irish | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | 134.9 MB |
| `models/opus-mt-en-mt` | [Helsinki-NLP/opus-mt-en-mt](https://huggingface.co/Helsinki-NLP/opus-mt-en-mt) | `c0ce1eed30f6c419955730df41faffb3f0b1119c` | Maltese | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | 133.8 MB |
| `models/opus-mt-en-gmq` | [Helsinki-NLP/opus-mt-en-gmq](https://huggingface.co/Helsinki-NLP/opus-mt-en-gmq) | `1011a691a63e61b4beb68d47332790e072f685f0` | Swedish (`>>swe<<`) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | 135.5 MB |
