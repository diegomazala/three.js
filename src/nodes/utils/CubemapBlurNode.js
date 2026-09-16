import TempNode from '../core/TempNode.js';
import { NodeUpdateType } from '../core/constants.js';
import { nodeProxy, float, vec2, vec3, Fn, If } from '../tsl/TSLBase.js';
import { cubeTexture } from '../accessors/CubeTextureNode.js';
import { textureSize } from '../accessors/TextureSizeNode.js';
import { positionWorldDirection } from '../accessors/Position.js';
import { abs, clamp, floor, max, min, mix, smoothstep } from '../math/MathNode.js';
import { select } from '../math/ConditionalNode.js';
import { getFace, getUV } from '../pmrem/PMREMUtils.js';
import { CubeTexture } from '../../textures/CubeTexture.js';
import CubemapBlurGenerator from '../../renderers/common/extras/CubemapBlurGenerator.js';

const _cache = new WeakMap();

// Direction (not normalized) of face coordinates in the getUV convention that may lie past the face
// edge. The texel grid continues into the neighbouring face at the same texel index along the edge, so
// coordinates past the edge land on the neighbour's texel centers rather than on the extrapolated face plane.
const cubeFaceDir = /*@__PURE__*/ Fn( ( [ face, uv ] ) => {

	const st = uv.mul( 2.0 ).sub( 1.0 ).toVar();
	const over = min( max( abs( st ).sub( 1.0 ), 0.0 ), 0.75 );
	st.assign( clamp( st, - 1.0, 1.0 ).div( over.x.oneMinus().mul( over.y.oneMinus() ) ) );

	const d0 = vec3( 1.0, st.y, st.x );
	const d1 = vec3( st.x.negate(), 1.0, st.y.negate() );
	const d2 = vec3( st.x.negate(), st.y, 1.0 );
	const d3 = vec3( - 1.0, st.y, st.x.negate() );
	const d4 = vec3( st.x.negate(), - 1.0, st.y );
	const d5 = vec3( st.x, st.y, - 1.0 );

	return select( face.lessThan( 0.5 ), d0, select( face.lessThan( 1.5 ), d1, select( face.lessThan( 2.5 ), d2, select( face.lessThan( 3.5 ), d3, select( face.lessThan( 4.5 ), d4, d5 ) ) ) ) );

} );

/**
 * Returns the per-renderer generator and cache of blurred cube maps. Render target
 * textures can't be shared across render contexts.
 *
 * @private
 * @param {Renderer} renderer - The renderer.
 * @return {{generator: CubemapBlurGenerator, entries: WeakMap<Texture, Object>}} The cache.
 */
function _getCache( renderer ) {

	let rendererCache = _cache.get( renderer );

	if ( rendererCache === undefined ) {

		rendererCache = { generator: new CubemapBlurGenerator( renderer ), entries: new WeakMap() };
		_cache.set( renderer, rendererCache );

	}

	return rendererCache;

}

/**
 * Blurs the given texture, reusing the previous result while the blurriness and the texture are unchanged.
 *
 * @private
 * @param {Texture} texture - The texture to blur.
 * @param {number} blurriness - The blurriness in the range `[0,1]`.
 * @param {Renderer} renderer - The renderer.
 * @return {?CubeRenderTarget} The render target holding the blurred cube map or `null` if the texture is not ready yet.
 */
function _getBlurredCubemap( texture, blurriness, renderer ) {

	const { generator, entries } = _getCache( renderer );

	let entry = entries.get( texture );

	if ( entry === undefined || entry.blurriness !== blurriness || entry.pmremVersion !== texture.pmremVersion ) {

		const image = texture.image;
		const ready = texture.isCubeTexture ? ( image.length === 6 && ! image.includes( undefined ) ) : ( image && image.height > 0 );

		if ( ! ready ) return null;

		if ( entry === undefined ) {

			entry = { renderTarget: null };
			entries.set( texture, entry );

			const onDispose = () => {

				texture.removeEventListener( 'dispose', onDispose );

				entries.delete( texture );
				entry.renderTarget.dispose();

			};

			texture.addEventListener( 'dispose', onDispose );

		}

		entry.renderTarget = generator.fromTexture( texture, blurriness, entry.renderTarget );
		entry.blurriness = blurriness;
		entry.pmremVersion = texture.pmremVersion;

	}

	return entry.renderTarget;

}

/**
 * This node samples an environment map blurred by {@link CubemapBlurGenerator}. The
 * blur is regenerated whenever {@link CubemapBlurNode#blurriness} changes.
 *
 * @augments TempNode
 */
class CubemapBlurNode extends TempNode {

	static get type() {

		return 'CubemapBlurNode';

	}

	/**
	 * Constructs a new cubemap blur node.
	 *
	 * @param {Texture} value - The texture to blur.
	 */
	constructor( value ) {

		super( 'vec3' );

		/**
		 * The texture to blur.
		 *
		 * @type {Texture}
		 */
		this.value = value;

		/**
		 * The blurriness in the range `[0,1]`, see {@link Scene#backgroundBlurriness}.
		 *
		 * @type {number}
		 * @default 0
		 */
		this.blurriness = 0;

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isCubemapBlurNode = true;

		const defaultTexture = new CubeTexture();
		defaultTexture.isRenderTargetTexture = true;

		/**
		 * The cube texture node sampling the blurred cube map.
		 *
		 * @private
		 * @type {CubeTextureNode}
		 */
		this._cubeTextureNode = cubeTexture( defaultTexture );

		/**
		 * The `updateBeforeType` is set to `NodeUpdateType.RENDER` since the node updates
		 * the blurred cube map once per render in its {@link CubemapBlurNode#updateBefore} method.
		 *
		 * @type {string}
		 * @default 'render'
		 */
		this.updateBeforeType = NodeUpdateType.RENDER;

	}

	updateBefore( frame ) {

		const renderTarget = _getBlurredCubemap( this.value, this.blurriness, frame.renderer );

		if ( renderTarget !== null ) this._cubeTextureNode.value = renderTarget.texture;

	}

	setup( builder ) {

		this.updateBefore( builder );

		const blurMap = this._cubeTextureNode;
		const uvNode = builder.context.getUV ? builder.context.getUV( blurMap ) : positionWorldDirection;

		// The blurred cube map's texels are only a few sigmas wide, bilinear magnification would show its
		// grid. Cubic B-spline reconstruction: four bilinear taps with the weights folded into the tap positions.
		return Fn( () => {

			const size = float( textureSize( blurMap, 0 ).x ).toVar();

			const direction = uvNode.toVar();
			const face = getFace( direction ).toVar();
			const uv = getUV( direction, face ).toVar();

			// texel i has its center at p = i
			const p = uv.mul( size ).sub( 0.5 );
			const i = floor( p ).toVar();
			const f = p.sub( i ).toVar();

			// cubic B-spline weights of texels i - 1 .. i + 2
			const f2 = f.mul( f ).toVar();
			const f3 = f2.mul( f ).toVar();
			const w0 = float( 1.0 ).sub( f.mul( 3.0 ) ).add( f2.mul( 3.0 ) ).sub( f3 ).div( 6.0 );
			const w1 = float( 4.0 ).sub( f2.mul( 6.0 ) ).add( f3.mul( 3.0 ) ).div( 6.0 );
			const w2 = float( 1.0 ).add( f.mul( 3.0 ) ).add( f2.mul( 3.0 ) ).sub( f3.mul( 3.0 ) ).div( 6.0 );
			const w3 = f3.div( 6.0 );

			// pair the taps: one bilinear fetch between i - 1 and i, one between i + 1 and i + 2
			const s0 = w0.add( w1 ).toVar();
			const s1 = w2.add( w3 ).toVar();
			const t0 = i.sub( 0.5 ).add( w1.div( s0 ) ).div( size ).toVar();
			const t1 = i.add( 1.5 ).add( w3.div( s1 ) ).div( size ).toVar();

			const tap = ( t ) => blurMap.sample( cubeFaceDir( face, t ) );

			const color = tap( vec2( t0.x, t0.y ) ).mul( s0.x.mul( s0.y ) )
				.add( tap( vec2( t1.x, t0.y ) ).mul( s1.x.mul( s0.y ) ) )
				.add( tap( vec2( t0.x, t1.y ) ).mul( s0.x.mul( s1.y ) ) )
				.add( tap( vec2( t1.x, t1.y ) ).mul( s1.x.mul( s1.y ) ) ).toVar();

			// the grids of the three faces meeting at a corner disagree within a texel or two, blend to bilinear there
			const st = abs( uv.mul( 2.0 ).sub( 1.0 ) );
			const texel = float( 2.0 ).div( size );
			const corner = smoothstep( texel, texel.mul( 2.0 ), min( st.x, st.y ).oneMinus() ).toVar();

			If( corner.lessThan( 1.0 ), () => {

				color.assign( mix( blurMap.sample( direction ), color, corner ) );

			} );

			return color;

		} )();

	}

}

export default CubemapBlurNode;

/**
 * TSL function for creating a cubemap blur node.
 *
 * @tsl
 * @function
 * @param {Texture} value - The texture to blur.
 * @returns {CubemapBlurNode}
 */
export const cubemapBlurTexture = /*@__PURE__*/ nodeProxy( CubemapBlurNode ).setParameterLength( 1 );
