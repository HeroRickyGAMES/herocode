import type { Plugin } from "@opencode-ai/plugin"
import { existsSync } from "node:fs"
import { writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

// Tesseract config via env vars:
//   TESSERACT_BIN  - path to tesseract binary (default: /usr/bin/tesseract)
//   TESSERACT_LANG - languages, e.g. "por+eng" (default: por+eng)
//   TESSERACT_PSM  - page segmentation mode (default: 3)
//     0  = orientation and script detection only
//     1  = automatic page segmentation with OSD
//     3  = fully automatic page segmentation (default)
//     4  = assume a single column of text
//     5  = assume a single uniform block of vertically aligned text
//     6  = assume a single uniform block of text
//     7  = treat the image as a single text line
//     8  = treat the image as a single word
//     9  = treat the image as a single word in a circle
//    10  = treat the image as a single character
//    11  = sparse text without order
//    12  = sparse text with order
//    13  = raw line
//   TESSERACT_OEM - OCR engine mode (default: 3)
//     0 = original Tesseract only
//     1 = neural nets LSTM only
//     2 = Tesseract + LSTM
//     3 = default (based on availability)
//   TESSERACT_DPI  - image DPI for preprocessing (default: 300)

const TESSERACT_BIN = process.env.TESSERACT_BIN || "/usr/bin/tesseract"
const TESSERACT_LANG = process.env.TESSERACT_LANG || "por+eng"
const TESSERACT_PSM = process.env.TESSERACT_PSM || "3"
const TESSERACT_OEM = process.env.TESSERACT_OEM || "3"
const TESSERACT_DPI = process.env.TESSERACT_DPI || "300"

async function runOcr(imageBuffer: Buffer, ext: string): Promise<string | null> {
  if (!existsSync(TESSERACT_BIN)) return null

  const tmpFile = join(tmpdir(), `ocr_${randomUUID()}${ext}`)
  try {
    await writeFile(tmpFile, imageBuffer)
    const proc = Bun.spawn(
      [
        TESSERACT_BIN,
        tmpFile,
        "stdout",
        "-l", TESSERACT_LANG,
        "--psm", TESSERACT_PSM,
        "--oem", TESSERACT_OEM,
        "--dpi", TESSERACT_DPI,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          TESSDATA_PREFIX: process.env.TESSDATA_PREFIX || "/usr/share/tesseract-ocr/5/tessdata",
        },
      },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return stdout.trim() || null
  } catch {
    return null
  } finally {
    try {
      await unlink(tmpFile)
    } catch {}
  }
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; ext: string } | null {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
  if (!match) return null
  const mime = match[1]
  const ext = mime.includes("png") ? ".png" : mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" : ".png"
  return { buffer: Buffer.from(match[2], "base64"), ext }
}

let partCounter = 0

export const id = "ocr"

const server: Plugin = async () => {
  return {
    "chat.message": async (_input, output) => {
      const toReplace: { index: number; textPart: any }[] = []

      for (let i = 0; i < output.parts.length; i++) {
        const part = output.parts[i]
        if (part.type !== "file" || !part.mime.startsWith("image/")) continue

        const decoded = decodeDataUrl(part.url)
        if (!decoded) continue

        const text = await runOcr(decoded.buffer, decoded.ext)
        if (!text) continue

        partCounter++
        toReplace.push({
          index: i,
          textPart: {
            id: `prt_ocr_${partCounter}_${Date.now()}` as any,
            sessionID: part.sessionID,
            messageID: part.messageID,
            type: "text" as const,
            text: `[OCR extraído da imagem]:\n${text}`,
          },
        })
      }

      // Replace image parts with OCR text (iterate in reverse to preserve indices)
      for (let j = toReplace.length - 1; j >= 0; j--) {
        const { index, textPart } = toReplace[j]
        output.parts.splice(index, 1, textPart)
      }
    },
  }
}

export default { id: "ocr", server } satisfies import("@opencode-ai/plugin").PluginModule
