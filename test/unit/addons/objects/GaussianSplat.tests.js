import { PerspectiveCamera } from 'three/webgpu';

import { GaussianSplat } from '../../../../examples/jsm/objects/GaussianSplat.js';
import { createGaussianSplatGeometry } from '../../../../examples/jsm/utils/GaussianSplatUtils.js';

// the camera sits at the origin looking down -Z, so view depth is -z
const DEPTHS = [ 0.2, 0.4, 0.6, 0.8, 5, - 5 ];

function createSplats() {

	const count = DEPTHS.length;
	const centers = new Float32Array( count * 3 );
	const covariances = new Float32Array( count * 6 );
	const colors = new Uint8Array( count * 4 ).fill( 255 );

	for ( let i = 0; i < count; i ++ ) {

		centers[ i * 3 + 2 ] = - DEPTHS[ i ];
		covariances[ i * 6 ] = covariances[ i * 6 + 3 ] = covariances[ i * 6 + 5 ] = 0.01;

	}

	return new GaussianSplat( createGaussianSplatGeometry( centers, covariances, colors ), { autoSort: false } );

}

function createCamera() {

	const camera = new PerspectiveCamera( 50, 1, 1, 100 );
	camera.updateMatrixWorld();

	return camera;

}

export default QUnit.module( 'Addons', () => {

	QUnit.module( 'Objects', () => {

		QUnit.module( 'GaussianSplat', () => {

			QUnit.test( 'sort range is not clamped to the near plane', ( assert ) => {

				const splats = createSplats();
				const camera = createCamera();

				splats.updateMatrixWorld();
				splats._updateSortUniforms( camera );

				const depth = - splats.boundingSphere.center.z;
				const radius = splats.boundingSphere.radius;
				const range = splats._sortDepthRange.value;

				assert.ok( depth - radius < camera.near, 'camera is inside the bounds' );
				assert.strictEqual( range.x, depth - radius, 'near end is depth - radius' );
				assert.strictEqual( range.y, depth + radius, 'far end is depth + radius' );

			} );

			QUnit.test( 'splats closer than the near plane get distinct, ordered bins', ( assert ) => {

				const splats = createSplats();
				const camera = createCamera();

				splats.updateMatrixWorld();
				splats._updateSortUniforms( camera );
				splats._sortCPU();

				const bins = splats._sort._cpuBins;
				const near = [ 0, 1, 2, 3 ];

				assert.strictEqual( new Set( near.map( ( i ) => bins[ i ] ) ).size, near.length, 'distinct bins' );

				for ( let i = 1; i < near.length; i ++ ) {

					assert.ok( bins[ near[ i ] ] < bins[ near[ i - 1 ] ], `splat ${ near[ i ] } is binned before nearer splat ${ near[ i - 1 ] }` );

				}

				const order = Array.from( splats._sort.orderAttribute.array );
				const expected = DEPTHS.map( ( d, i ) => i ).sort( ( a, b ) => DEPTHS[ b ] - DEPTHS[ a ] );

				assert.deepEqual( order, expected, 'draw order is back to front' );

			} );

		} );

	} );

} );
