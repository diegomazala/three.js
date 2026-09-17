import { cubemapBlurTexture } from '../../../../../src/nodes/utils/CubemapBlurNode.js';
import CubemapBlurGenerator from '../../../../../src/renderers/common/extras/CubemapBlurGenerator.js';
import CubeRenderTarget from '../../../../../src/renderers/common/CubeRenderTarget.js';
import NodeManager from '../../../../../src/renderers/common/nodes/NodeManager.js';
import { Scene } from '../../../../../src/scenes/Scene.js';
import { CubeTexture } from '../../../../../src/textures/CubeTexture.js';
import { Texture } from '../../../../../src/textures/Texture.js';

export default QUnit.module( 'Nodes', () => {

	QUnit.module( 'Utils', () => {

		QUnit.module( 'CubemapBlurNode', ( hooks ) => {

			let fromTexture, calls, disposals;

			hooks.beforeEach( () => {

				calls = [];
				disposals = new Map();
				fromTexture = CubemapBlurGenerator.prototype.fromTexture;

				// Model target reuse and resizing without a GPU.
				CubemapBlurGenerator.prototype.fromTexture = function ( texture, amount, renderTarget = null ) {

					const size = amount < 0.5 ? 64 : 16;

					if ( renderTarget !== null && renderTarget.width !== size ) {

						renderTarget.dispose();
						renderTarget = null;

					}

					if ( renderTarget === null ) {

						renderTarget = new CubeRenderTarget( size );
						const target = renderTarget;
						disposals.set( target.texture, 0 );
						target.addEventListener( 'dispose', () => {

							disposals.set( target.texture, disposals.get( target.texture ) + 1 );

						} );

					}

					renderTarget.texture.userData.amount = amount;
					calls.push( { texture, amount, renderTarget } );

					return renderTarget;

				};

			} );

			hooks.afterEach( () => {

				CubemapBlurGenerator.prototype.fromTexture = fromTexture;

			} );

			QUnit.test( 'nodes sharing a source keep independent results', ( assert ) => {

				const source = new Texture( { height: 32 } );
				const first = cubemapBlurTexture( source );
				const second = cubemapBlurTexture( source );
				const frame = { renderer: {} };

				first.amount = 0.2;
				second.amount = 0.3;
				first.updateBefore( frame );
				second.updateBefore( frame );

				const firstOutput = first._cubeTextureNode.value;
				const secondOutput = second._cubeTextureNode.value;

				assert.notStrictEqual( firstOutput, secondOutput, 'Different nodes have separate output textures even at the same size.' );
				assert.strictEqual( firstOutput.userData.amount, 0.2, 'The second blur does not overwrite the first result.' );

				first.updateBefore( frame );
				second.updateBefore( frame );
				assert.strictEqual( calls.length, 2, 'Rendering both nodes again reuses both cached results.' );

				first.amount = 0.4;
				first.updateBefore( frame );
				assert.strictEqual( first._cubeTextureNode.value, firstOutput, 'Changing amount reuses the owning node\'s target when its size fits.' );
				assert.strictEqual( secondOutput.userData.amount, 0.3, 'Changing one amount leaves the other output unchanged.' );

				first.amount = 0.8;
				first.updateBefore( frame );
				assert.notStrictEqual( first._cubeTextureNode.value, firstOutput, 'Changing size replaces the owning node\'s target.' );
				assert.strictEqual( disposals.get( firstOutput ), 1, 'The replaced target is disposed.' );
				assert.strictEqual( disposals.get( secondOutput ), 0, 'The other node\'s target remains valid.' );

				second.updateBefore( frame );
				assert.strictEqual( calls.length, 4, 'Updating the unaffected node does not regenerate its result.' );
				assert.strictEqual( second._cubeTextureNode.value, secondOutput, 'The unaffected node keeps its output.' );

				source.dispose();

			} );

			QUnit.test( 'one node keeps a separate result for each renderer', ( assert ) => {

				const source = new Texture( { height: 32 } );
				const node = cubemapBlurTexture( source );
				const firstFrame = { renderer: {} };
				const secondFrame = { renderer: {} };

				node.updateBefore( firstFrame );
				const firstOutput = node._cubeTextureNode.value;
				node.updateBefore( secondFrame );
				const secondOutput = node._cubeTextureNode.value;

				assert.notStrictEqual( firstOutput, secondOutput, 'Render contexts do not share targets.' );

				node.updateBefore( firstFrame );
				assert.strictEqual( node._cubeTextureNode.value, firstOutput, 'Returning to the first renderer restores its output.' );
				node.updateBefore( secondFrame );
				assert.strictEqual( node._cubeTextureNode.value, secondOutput, 'Returning to the second renderer restores its output.' );
				assert.strictEqual( calls.length, 2, 'Both renderer results are reused.' );

				node.dispose();
				assert.strictEqual( disposals.get( firstOutput ), 1, 'Node disposal releases the first renderer target.' );
				assert.strictEqual( disposals.get( secondOutput ), 1, 'Node disposal releases the second renderer target.' );

				node.dispose();
				source.dispose();
				assert.strictEqual( disposals.get( firstOutput ), 1, 'Repeated disposal does not release the first target twice.' );
				assert.strictEqual( disposals.get( secondOutput ), 1, 'Repeated disposal does not release the second target twice.' );

			} );

			QUnit.test( 'source version changes refresh each node once', ( assert ) => {

				const source = new Texture( { height: 32 } );
				const first = cubemapBlurTexture( source );
				const second = cubemapBlurTexture( source );
				const frame = { renderer: {} };

				first.updateBefore( frame );
				second.updateBefore( frame );
				const firstOutput = first._cubeTextureNode.value;
				const secondOutput = second._cubeTextureNode.value;

				source.needsPMREMUpdate = true;
				first.updateBefore( frame );
				second.updateBefore( frame );
				assert.strictEqual( calls.length, 4, 'A source version change refreshes both outputs.' );
				assert.strictEqual( first._cubeTextureNode.value, firstOutput, 'The first node reuses its target.' );
				assert.strictEqual( second._cubeTextureNode.value, secondOutput, 'The second node reuses its target.' );

				first.updateBefore( frame );
				second.updateBefore( frame );
				assert.strictEqual( calls.length, 4, 'The refreshed results are cached.' );

				source.dispose();

			} );

			QUnit.test( 'unready sources wait for their images', ( assert ) => {

				const frame = { renderer: {} };
				const source = new Texture();
				const node = cubemapBlurTexture( source );
				const initialOutput = node._cubeTextureNode.value;

				node.updateBefore( frame );
				assert.strictEqual( calls.length, 0, 'An unloaded image is not blurred.' );
				assert.strictEqual( node._cubeTextureNode.value, initialOutput, 'The placeholder remains available.' );

				source.image = { height: 32 };
				node.updateBefore( frame );
				assert.strictEqual( calls.length, 1, 'The loaded image is blurred on the next update.' );

				const cubeSource = new CubeTexture( [ {}, {}, {}, {}, {}, undefined ] );
				const cubeNode = cubemapBlurTexture( cubeSource );
				cubeNode.updateBefore( frame );
				assert.strictEqual( calls.length, 1, 'A cube texture waits for every face.' );

				cubeSource.image[ 5 ] = {};
				cubeNode.updateBefore( frame );
				assert.strictEqual( calls.length, 2, 'A complete cube texture is blurred.' );

				source.dispose();
				cubeSource.dispose();

			} );

			QUnit.test( 'changing source reuses the target and detaches its old source', ( assert ) => {

				const source = new Texture( { height: 32 } );
				const replacement = new Texture();
				const node = cubemapBlurTexture( source );
				const frame = { renderer: {} };

				node.updateBefore( frame );
				const output = node._cubeTextureNode.value;
				node.value = replacement;
				node.updateBefore( frame );
				assert.strictEqual( calls.length, 1, 'An unready replacement is not blurred.' );
				assert.strictEqual( node._cubeTextureNode.value, output, 'The previous output is retained until the replacement is ready.' );

				replacement.image = { height: 32 };
				node.updateBefore( frame );
				assert.strictEqual( calls.length, 2, 'A new source with the same version still regenerates the blur.' );
				assert.strictEqual( calls[ 1 ].texture, replacement, 'The replacement source is blurred.' );
				assert.strictEqual( node._cubeTextureNode.value, output, 'The same-size target is reused.' );

				source.dispose();
				assert.strictEqual( disposals.get( output ), 0, 'Disposing the previous source does not dispose the current output.' );
				replacement.dispose();
				assert.strictEqual( disposals.get( output ), 1, 'Disposing the current source releases the output.' );

			} );

			QUnit.test( 'source and node disposal release only their owned targets', ( assert ) => {

				const source = new Texture( { height: 32 } );
				const first = cubemapBlurTexture( source );
				const second = cubemapBlurTexture( source );
				const frame = { renderer: {} };

				first.updateBefore( frame );
				second.updateBefore( frame );
				const firstOutput = first._cubeTextureNode.value;
				const secondOutput = second._cubeTextureNode.value;

				first.dispose();
				assert.strictEqual( disposals.get( firstOutput ), 1, 'Disposing a node releases its output.' );
				assert.strictEqual( disposals.get( secondOutput ), 0, 'The other node keeps its output.' );
				second.updateBefore( frame );
				assert.strictEqual( calls.length, 2, 'The other node still reuses its result.' );

				source.dispose();
				assert.strictEqual( disposals.get( firstOutput ), 1, 'The disposed node no longer responds to source disposal.' );
				assert.strictEqual( disposals.get( secondOutput ), 1, 'Source disposal releases the remaining output.' );

				second.updateBefore( frame );
				const newOutput = second._cubeTextureNode.value;
				assert.notStrictEqual( newOutput, secondOutput, 'Rendering after source disposal creates a fresh target.' );
				second.dispose();
				source.dispose();
				assert.strictEqual( disposals.get( newOutput ), 1, 'The regenerated result is released exactly once.' );

			} );

			QUnit.test( 'automatic backgrounds reuse their blur node after returning to zero', ( assert ) => {

				const renderer = {};
				const manager = new NodeManager( renderer, {} );
				const scene = new Scene();
				scene.background = new CubeTexture( [ {}, {}, {}, {}, {}, {} ] );
				scene.backgroundBlurriness = 0.3;

				manager.updateBackground( scene );
				const node = manager.get( scene ).backgroundNode;
				node.updateBefore( { renderer } );
				const output = node._cubeTextureNode.value;

				scene.backgroundBlurriness = 0;
				manager.updateBackground( scene );
				assert.notStrictEqual( manager.get( scene ).backgroundNode, node, 'A sharp background uses its own node.' );

				scene.backgroundBlurriness = 0.3;
				manager.updateBackground( scene );
				const restoredNode = manager.get( scene ).backgroundNode;
				assert.strictEqual( restoredNode, node, 'Restoring blur reuses its cached node.' );
				restoredNode.updateBefore( { renderer } );
				assert.strictEqual( restoredNode._cubeTextureNode.value, output, 'Restoring blur reuses its cached output.' );
				assert.strictEqual( calls.length, 1, 'Restoring the same amount does not regenerate the blur.' );

				scene.background.dispose();

			} );

		} );

	} );

} );
