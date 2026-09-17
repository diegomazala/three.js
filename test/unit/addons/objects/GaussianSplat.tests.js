import { PerspectiveCamera } from 'three';
import { GaussianSplat } from '../../../../examples/jsm/objects/GaussianSplat.js';
import { createGaussianSplatGeometry } from '../../../../examples/jsm/utils/GaussianSplatUtils.js';

const webGLRenderer = { backend: { isWebGLBackend: true } };

function createSplats( centers, options ) {

	const count = centers.length / 3;
	const covariances = new Float32Array( count * 6 );
	const colors = new Uint8Array( count * 4 ).fill( 255 );

	for ( let i = 0; i < count; i ++ ) {

		covariances[ i * 6 ] = covariances[ i * 6 + 3 ] = covariances[ i * 6 + 5 ] = 0.01;

	}

	return new GaussianSplat( createGaussianSplatGeometry( new Float32Array( centers ), covariances, colors ), options );

}

function createCamera() {

	const camera = new PerspectiveCamera( 60, 1, 0.01, 100 );
	camera.updateMatrixWorld();

	return camera;

}

export default QUnit.module( 'Addons', () => {

	QUnit.module( 'Objects', () => {

		QUnit.module( 'GaussianSplat', () => {

			// Splat 1 is farther by view depth, splat 0 is farther by camera distance.
			const centers = [ 3, 0, - 1.5, 0, 0, - 2 ];

			QUnit.test( 'sorts back to front by view depth by default', ( assert ) => {

				const splats = createSplats( centers );
				splats.updateSort( webGLRenderer, createCamera() );

				assert.deepEqual( Array.from( splats._sort.orderAttribute.array ), [ 1, 0 ], 'farthest view depth first' );

			} );

			QUnit.test( 'sorts back to front by camera distance with sortRadial', ( assert ) => {

				const splats = createSplats( centers, { sortRadial: true } );
				splats.updateSort( webGLRenderer, createCamera() );

				assert.deepEqual( Array.from( splats._sort.orderAttribute.array ), [ 0, 1 ], 'farthest camera distance first' );

			} );

			QUnit.test( 'radial sort ignores rotation and re-sorts on relative translation', ( assert ) => {

				const splats = createSplats( centers, { sortRadial: true } );
				const camera = createCamera();
				splats.updateSort( webGLRenderer, camera );

				const step = splats.boundingSphere.radius * 0.01;

				camera.rotation.y = Math.PI / 4;
				camera.updateMatrixWorld();
				assert.false( splats.updateSort( webGLRenderer, camera ), 'rotation alone does not re-sort' );

				camera.position.x = step * 0.01;
				camera.updateMatrixWorld();
				assert.false( splats.updateSort( webGLRenderer, camera ), 'sub-bin translation does not re-sort' );

				camera.position.x = step;
				camera.updateMatrixWorld();
				assert.true( splats.updateSort( webGLRenderer, camera ), 'translation re-sorts' );

				splats.scale.setScalar( 100 );
				camera.position.x += step;
				camera.updateMatrixWorld();
				splats.updateSort( webGLRenderer, camera );
				camera.position.x += step;
				camera.updateMatrixWorld();
				assert.false( splats.updateSort( webGLRenderer, camera ), 'threshold scales with the splats' );

			} );

			QUnit.test( 'view-depth sort re-sorts on rotation only', ( assert ) => {

				const splats = createSplats( centers );
				const camera = createCamera();
				splats.updateSort( webGLRenderer, camera );

				camera.position.x = 1;
				camera.updateMatrixWorld();
				assert.false( splats.updateSort( webGLRenderer, camera ), 'translation alone does not re-sort' );

				camera.rotation.y = Math.PI / 4;
				camera.updateMatrixWorld();
				assert.true( splats.updateSort( webGLRenderer, camera ), 'rotation re-sorts' );

			} );

		} );

	} );

} );
