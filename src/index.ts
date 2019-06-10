import 'source-map-support/register';
import { CogTif } from "./cog.tif";
import { CogSourceFile } from "./cog.source.file";
import { CogSourceUrl } from './cog.source.web';
import { writeFileSync } from 'fs';

function isWeb() {
    return typeof window !== 'undefined';
}

function getSource() {
    if (typeof fetch === 'undefined') {
        // return new CogSourceFile('/home/blacha/Downloads/tif/S2A_MSIL1C_20170102T111442_N0204_R137_T30TXT_20170102T111441_TCI_cloudoptimized_512.tif')
        return new CogSourceFile('/home/blacha/Downloads/tif/land_shallow_topo_east.cog.webp.tif')
    }
    return new CogSourceUrl('/land_shallow_topo_east_webp.tif');

}
async function run() {
    const cl = new CogTif(getSource())

    await cl.init();
    console.log('Loaded');

    if (isWeb()) {
        for (let y = 0; y < 10; y++) {
            for (let x = 0; x < 10; x++) {
                cl.getTileRaw(y, x, 0)
            }
        }

        for (let y = 0; y < 10; y++) {
            const div = document.createElement('div');
            div.style.display = 'flex'
            div.style.flexDirection = 'column';
            for (let x = 0; x < 10; x++) {
                const tile = await cl.getTileRaw(y, x, 0)
                const img = document.createElement('img');
                img.style.width = '64px';
                img.style.height = '64px';
                img.style.outline = '1px solid black';
                const blob = new Blob([tile.bytes], { type: 'image/webp' });
                img.src = URL.createObjectURL(blob);
                div.appendChild(img);
            }
            document.getElementById('container').appendChild(div);

        }
    }



    // if (!isWeb()) {
    //     const y = 5;
    //     const z = 0;

    //     for (let x = 0; x < 10; x++) {
    //         const tile = await cl.getTileRaw(x, 5, 0)
    //         // console.log('tile', x, y, z, tile.mimeType, Buffer.from(tile.bytes).length)
    //         // writeFileSync(`output/${x}_${y}_${z}.webp`, Buffer.from(tile.bytes))
    //     }
    // }
}



run().catch(console.error.bind(console))
