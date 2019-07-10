import { CommandLineAction, CommandLineStringParameter, CommandLineIntegerParameter } from '@microsoft/ts-command-line';
import { ActionUtil, CliResultMap } from './action.util';
import * as path from 'path';
import { Logger } from '../util/util.log';
import { promises as fs } from 'fs';
import { CogTif } from '../cog.tif';
import { MimeType, TiffVersion } from '../read/tif';
import { toByteSizeString } from '../util/util.bytes';
import chalk from 'chalk';
import { CogTifImage } from '../cog.tif.image';

const FileExtension: { [key: string]: string } = {
    [MimeType.JPEG]: 'jpeg',
    [MimeType.JP2]: 'jp2',
    [MimeType.WEBP]: 'webp',
};

const Rad2Deg = 180 / Math.PI;
const A = 6378137.0; // 900913 properties.
function toLatLng(x: number, y: number) {
    return [(x * Rad2Deg) / A, (Math.PI * 0.5 - 2.0 * Math.atan(Math.exp(-y / A))) * Rad2Deg];
}

function getTileName(mimeType: string, zoom: number, x: number, y: number) {
    const xS = `${x}`.padStart(3, '0');
    const yS = `${y}`.padStart(3, '0');

    const fileExt: string = FileExtension[mimeType];
    if (fileExt == null) {
        throw new Error(`Unable to process tile type:${mimeType}`);
    }

    return `${xS}_${yS}_z${zoom}.${fileExt}`;
}

async function writeTile(tif: CogTif, x: number, y: number, zoom: number, output: string) {
    const tile = await tif.getTileRaw(x, y, zoom);
    if (tile == null) {
        Logger.error('Unable to write file, missing data..');
        return;
    }
    const fileName = getTileName(tile.mimeType, zoom, x, y);
    fs.writeFile(path.join(output, fileName), tile.bytes);
    Logger.debug({ fileName }, 'WriteFile');
}

export interface GeoJsonPolygon {
    type: 'Feature';
    geometry: {
        type: 'Polygon';
        coordinates: [[[number, number], [number, number], [number, number], [number, number], [number, number]]];
    };
    properties: {};
}

function makePolygon(xMin: number, yMin: number, xMax: number, yMax: number): GeoJsonPolygon {
    const [lngMin, latMin] = toLatLng(xMin, yMin);
    const [lngMax, latMax] = toLatLng(xMax, yMax);

    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [[[lngMin, latMin], [lngMin, latMax], [lngMax, latMax], [lngMax, latMin], [lngMin, latMin]]],
        },
    };
}

export class ActionDumpTile extends CommandLineAction {
    private file: CommandLineStringParameter | null = null;
    private zoom: CommandLineIntegerParameter | null = null;
    private output: CommandLineStringParameter | null = null;
    private outputCount: number = 0;

    public constructor() {
        super({
            actionName: 'dump',
            summary: 'Dump tiles from a COG',
            documentation: 'Stuff',
        });
    }

    // TODO this only works for WSG84
    async dumpBounds(tif: CogTif, output: string, zoom: number) {
        Logger.info({ zoom }, 'CreateTileBounds');
        const img = tif.getImage(zoom);

        const features: GeoJsonPolygon[] = [];
        const featureCollection = {
            type: 'FeatureCollection',
            features,
        };

        const tileCount = img.tileCount;
        const tileInfo = img.tileInfo;
        const tileSize = img.size;

        const firstImage = tif.images[0];
        const firstTileSize = firstImage.size;
        const origin = firstImage.origin;
        const resolution = firstImage.resolution;

        const xScale = (resolution[0] * firstTileSize.width) / tileSize.width;
        const yScale = (resolution[1] * firstTileSize.height) / tileSize.height;

        for (let y = 0; y < tileCount.ny; y++) {
            const yMax = origin[1] + y * tileInfo.height * yScale;
            const yMin = yMax + tileInfo.height * yScale;
            for (let x = 0; x < tileCount.nx; x++) {
                const xMin = origin[0] + x * tileInfo.width * xScale;
                const xMax = xMin + tileInfo.width * xScale;
                features.push(makePolygon(xMin, yMin, xMax, yMax));
            }
        }

        await fs.writeFile(path.join(output, `z${zoom}.bounds.geojson`), JSON.stringify(featureCollection, null, 2));
    }

    async dumpIndex(tif: CogTif, output: string, zoom: number) {
        Logger.info({ zoom }, 'CreateIndexHtml');
        const img = tif.getImage(zoom);
        const tileCount = img.tileCount;

        const html = ['<html>'];
        for (let y = 0; y < tileCount.ny; y++) {
            html.push('\t<div style="display:flex;">');
            for (let x = 0; x < tileCount.nx; x++) {
                const tile = await tif.getTileRaw(x, y, zoom);
                if (tile == null) {
                    continue;
                }

                html.push(`\t\t<img src="./${getTileName(tile.mimeType, zoom, x, y)}" >`);
            }

            html.push('\t</div>');
        }
        html.push('</html>');
        await fs.writeFile(path.join(output, 'index.html'), html.join('\n'));
    }

    async dumpTiles(tif: CogTif, output: string, zoom: number) {
        const promises: Promise<void>[] = [];
        const img = tif.getImage(zoom);

        Logger.info({ ...img.tileInfo, ...img.tileCount }, 'TileInfo');
        const tileCount = img.tileCount;

        for (let x = 0; x < tileCount.nx; x++) {
            for (let y = 0; y < tileCount.ny; y++) {
                // TODO should limit how many of these we run at a time
                promises.push(writeTile(tif, x, y, zoom, output));
                this.outputCount++;
            }
        }
        await Promise.all(promises);

        Logger.info({ zoom }, 'CreateTileBounds');
    }

    async onExecute(): Promise<void> {
        if (this.zoom == null || this.zoom.value == null || this.output == null || this.output.value == null) {
            return;
        }
        this.outputCount = 0;

        const { tif } = await ActionUtil.getCogSource(this.file);
        const zoom = this.zoom.value;
        if (zoom == null || zoom > tif.images.length - 1 || zoom < -1) {
            this.renderHelpText();
            throw Error(`Invalid zoom level "${zoom}" must be between 0 - ${tif.images.length - 1}`);
        }

        const img = tif.getImage(zoom);
        if (!img.isTiled()) {
            throw Error('Tif file is not tiled.');
        }

        const output = path.join(this.output.value, `z${zoom}`);
        await fs.mkdir(output, { recursive: true });
        await this.dumpTiles(tif, output, zoom);
        await this.dumpIndex(tif, output, zoom);
        for (let i = 0; i < tif.images.length; i++) {
            await this.dumpBounds(tif, this.output.value, i);
        }

        const chunkIds = Object.keys(tif.source._chunks).filter(f => tif.source.chunk(parseInt(f, 10)).isReady());
        const result: CliResultMap[] = [
            {
                keys: [
                    { key: 'Tiff type', value: `${TiffVersion[tif.source.version]} (v${String(tif.source.version)})` },
                    { key: 'Chunk size', value: toByteSizeString(tif.source.chunkSize) },
                    {
                        key: 'Bytes read',
                        value:
                            `${toByteSizeString(chunkIds.length * tif.source.chunkSize)} ` +
                            `(${chunkIds.length} Chunk${chunkIds.length === 1 ? '' : 's'})`,
                    },
                ],
            },
            {
                title: 'Output',
                keys: [{ key: 'Images', value: this.outputCount }],
            },
        ];
        const msg = ActionUtil.formatResult(chalk`{bold COG File Info} - {bold ${tif.source.name}}`, result);
        console.log(msg.join('\n'));
        return Promise.resolve();
    }

    protected onDefineParameters(): void {
        this.file = this.defineStringParameter({
            argumentName: 'FILE',
            parameterLongName: '--file',
            parameterShortName: '-f',
            description: 'cog file to access',
            required: true,
        });

        this.zoom = this.defineIntegerParameter({
            argumentName: 'ZOOM',
            parameterShortName: '-z',
            parameterLongName: '--zoom',
            description: 'Zoom level to export',
            required: true,
        });

        this.output = this.defineStringParameter({
            argumentName: 'OUTPUT',
            parameterShortName: '-o',
            parameterLongName: '--output',
            description: 'Zoom level to export',
            required: true,
        });
    }
}
