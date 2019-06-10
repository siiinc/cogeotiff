import { TIFF_SIZE, TIFF_TAG, TIFF_COMPRESSION, TIFF_TAG_TYPE } from './tif';
import { CogFileSource } from './cog.source.file';
import { CogSource } from './cog.source';

const VERSION_TIFF = 42;
const VERSION_BIGTIFF = 43;

const ENDIAN_BIG = 0x4D4D
const ENDIAN_LITTLE = 0x4949

interface CogImage {
    Compression: number;
    ImageWidth: number;
    ImageLength: number;
    TileWidth: number;
    TileLength: number;
    TileOffsets: number[];
    TileByteCounts: number[];
}

export class CogLayer {

    source: CogSource;
    version: number;
    isLittleEndian: boolean;
    isBigTiff = false;

    images: Partial<CogImage>[] = [];

    constructor(source: CogSource) {
        this.source = source
    }

    async init() {
        await this.fetchHeader();
    }

    async fetchHeader() {
        const endian = await this.source.uint16(0);

        console.log(endian)
        this.isLittleEndian = endian === ENDIAN_LITTLE
        if (!this.isLittleEndian) {
            throw new Error('Only little endian is supported');
        }

        this.version = await this.source.uint16(2);
        if (this.version == VERSION_BIGTIFF) {
            throw new Error(`Only tiff supported version:${this.version}`)
        }

        if (this.version != VERSION_TIFF) {
            throw new Error(`Only tiff supported version:${this.version}`)
        }

        const offset = await this.source.uint32(4);

        if (!this.source.hasBytes(offset)) {
            throw new Error('Offset out of range');
        }

        await this.processIfd(offset);
    }

    async getTileRaw(x: number, y: number, z: number): Promise<{ mimeType: string, bytes: ArrayBuffer }> {
        const image = this.images[z];
        if (image == null) {
            throw new Error(`Missing z: ${z}`);
        }
        const mimeType = TIFF_COMPRESSION[image.Compression]
        const nyTiles = Math.ceil(image.ImageLength / image.TileLength);
        const idx = y * nyTiles + x;
        if (idx > image.TileOffsets.length) {
            throw new Error(`Tile ${x} ${y} ${z} does not exist`)
        }

        const offset = image.TileOffsets[idx];
        const byteCount = image.TileByteCounts[idx];
        // TODO fix JPEG
        const bytes = await this.source.getBytes(offset, byteCount);
        return { mimeType, bytes }
    }

    async processIfd(offset: number) {
        const ifd = await this.readIfd(offset);
        this.images.push(ifd.image);
        // TODO dynamically load these as needed
        if (ifd.nextOffset) {
            await this.processIfd(ifd.nextOffset);
        }
    }

    private async readIfd(offset: number) {
        const tagCount = await this.source.uint16(offset);

        const byteStart = offset + 2;
        const byteEnds = tagCount * 12 + 2 + byteStart;

        let pos = 0;
        const image: Partial<CogImage> = {};
        let isPartial = false;

        console.log(`${offset} @ ${byteStart} - ${byteEnds} ${tagCount}`);
        for (let i = 0; i < tagCount; i++) {
            pos = byteStart + 12 * i;
            const tagCode = await this.source.uint16(pos)
            const tiffTag = TIFF_TAG[tagCode]

            if (tiffTag == null) {
                console.log(`Unknown code ${tagCode}`)
                continue;
            }

            const tagType = await this.source.uint16(pos + 2);
            const typeSize = TIFF_SIZE[tagType]

            const count = await this.source.uint32(pos + 4)
            const tagLen = count * typeSize.length

            console.log(pos - 10, 'tag', tiffTag, 'type', TIFF_TAG_TYPE[tagType], 'typeCount', count, 'tagLen', tagLen)

            if (tagLen <= 4) {
                image[tiffTag] = await this.source.readType(pos + 8, tagType, count);
            } else {
                const valueOffset = await this.source.uint32(pos + 8);
                const valueEnd = valueOffset + tagLen;
                if (!this.source.hasBytes(valueOffset, tagLen)) {
                    console.error(`Need More data ${valueEnd} >`);
                    image[tiffTag] = () => this.source.readType(valueOffset, tagType, count);
                    isPartial = true;
                } else {
                    image[tiffTag] = await this.source.readType(valueOffset, tagType, count);
                }
            }
        }

        const nextOffset = await this.source.uint32(offset + tagCount * 12 + 2);
        return { nextOffset, image }
    }
}

