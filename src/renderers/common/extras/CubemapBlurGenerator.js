import NodeMaterial from '../../../materials/nodes/NodeMaterial.js';
import CubeRenderTarget from '../CubeRenderTarget.js';
import { CubeCamera } from '../../../cameras/CubeCamera.js';
import { floorPowerOfTwo } from '../../../math/MathUtils.js';
import { Mesh } from '../../../objects/Mesh.js';
import { BoxGeometry } from '../../../geometries/BoxGeometry.js';
import { CubeTexture } from '../../../textures/CubeTexture.js';
import { uniform } from '../../../nodes/core/UniformNode.js';
import { property } from '../../../nodes/core/PropertyNode.js';
import { texture } from '../../../nodes/accessors/TextureNode.js';
import { cubeTexture } from '../../../nodes/accessors/CubeTextureNode.js';
import { pmremTexture } from '../../../nodes/pmrem/PMREMNode.js';
import { positionWorldDirection } from '../../../nodes/accessors/Position.js';
import { equirectUV } from '../../../nodes/utils/EquirectUV.js';
import { Fn, float, vec2, vec3, vec4 } from '../../../nodes/tsl/TSLBase.js';
import { abs, acos, atan, clamp, cross, dot, exp, inverseSqrt, normalize, sqrt, dFdx, dFdy } from '../../../nodes/math/MathNode.js';
import { select } from '../../../nodes/math/ConditionalNode.js';
import { Loop } from '../../../nodes/utils/LoopNode.js';
import { BackSide, CubeUVReflectionMapping, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, LinearSRGBColorSpace, NoBlending } from '../../../constants.js';

// sharp copy of the environment, its mip chain feeds the blur
const SOURCE_SIZE = 256;
const SUPERSAMPLING = 4;

// the blurred cube map is sized so sigma spans 1.5 to 3 of its texels, down to this size
const SIGMA_TEXELS = 3;
const MIN_SIZE = 16;

// taps at the source texel spacing cover 3.5 sigma, the source level has twice the target's size where available
const TAP_RADIUS = 12;

// the smallest size blurs too wide for a tangent plane and sums every texel of this source level instead
const SPHERE_SOURCE_SIZE = 32;

const _defaultCubeTexture = /*@__PURE__*/ new CubeTexture();
_defaultCubeTexture.isRenderTargetTexture = true;

/**
 * Blurs an environment map with an angular Gaussian into a cube map, the way a real
 * blur of the background would look. The result is sized to the blur: from 256 faces
 * for the finest blur down to 16 for the average of the whole map.
 *
 * The renderer uses it for {@link Scene#backgroundBlurriness}.
 *
 * @private
 */
class CubemapBlurGenerator {

	/**
	 * Constructs a new cubemap blur generator.
	 *
	 * @param {Renderer} renderer - The renderer.
	 */
	constructor( renderer ) {

		this._renderer = renderer;
		this._mesh = new Mesh( new BoxGeometry( 5, 5, 5 ), null );
		this._cubeCamera = new CubeCamera( 1, 10, null );

		this._source = null;
		this._sourceTexture = null;
		this._sourceVersion = - 1;

		this._copyPass = null;
		this._blurPass = null;
		this._spherePass = null;

	}

	/**
	 * Blurs an equirectangular, cube or PMREM (cubeUV) texture. Blurriness `1 / 9` gives a
	 * sigma of 0.9 degrees, every further `1 / 9` doubles it up to the average of the whole
	 * map at `1`, below `1 / 9` the blur ramps down to sharp.
	 *
	 * @param {Texture} texture - The environment texture.
	 * @param {number} blurriness - The blurriness in the range `[0,1]`.
	 * @param {?CubeRenderTarget} [renderTarget=null] - A previous result to update, replaced when its size does not fit.
	 * @return {CubeRenderTarget} The cube render target with the blurred environment.
	 */
	fromTexture( texture, blurriness, renderTarget = null ) {

		const renderer = this._renderer;

		const sigma = _getSigma( blurriness );
		const size = Math.min( Math.max( floorPowerOfTwo( SIGMA_TEXELS * 2 / sigma ), MIN_SIZE ), SOURCE_SIZE );

		if ( renderTarget !== null && renderTarget.width !== size ) {

			renderTarget.dispose();
			renderTarget = null;

		}

		const target = renderTarget || _createTarget( size );

		const currentMRT = renderer.getMRT();
		const autoClear = renderer.autoClear;

		renderer.setMRT( null );
		renderer.autoClear = false;

		this._copy( texture );
		this._blur( target, sigma );

		renderer.setMRT( currentMRT );
		renderer.autoClear = autoClear;

		return target;

	}

	/**
	 * Frees the GPU-related resources allocated by this instance. Call this method whenever this instance is no longer used in your app.
	 */
	dispose() {

		if ( this._source !== null ) this._source.dispose();
		if ( this._copyPass !== null ) this._copyPass.material.dispose();
		if ( this._blurPass !== null ) this._blurPass.material.dispose();
		if ( this._spherePass !== null ) this._spherePass.material.dispose();

		this._mesh.geometry.dispose();

	}

	// private interface

	_copy( texture ) {

		if ( this._sourceTexture === texture && this._sourceVersion === texture.pmremVersion ) return;

		if ( this._source === null ) {

			this._source = _createTarget( SOURCE_SIZE, true );

			// allocate the mip chain now, CubeCamera renders all but the last face with mipmaps off
			this._renderer.initRenderTarget( this._source );

		}

		// the sampler node bakes the source type and orientation into the shader
		let pass = this._copyPass;

		if ( pass === null || pass.texture !== texture ) {

			if ( pass !== null ) pass.material.dispose();

			pass = this._copyPass = _createCopyPass( texture );

		}

		this._render( pass.material, this._source );

		this._sourceTexture = texture;
		this._sourceVersion = texture.pmremVersion;

	}

	_blur( target, sigma ) {

		const size = target.width;
		const sourceSize = Math.min( 2 * size, SOURCE_SIZE );

		// tap spacing is the source texel angle at the face center
		const spacing = 2 / sourceSize;

		// the taps interpolate the source bilinearly and the background reconstructs the result
		// with a cubic B-spline, remove the variance both add
		const texel = 2 / size;
		const bakeSigma = Math.max( Math.sqrt( Math.max( sigma * sigma - texel * texel / 3 - spacing * spacing / 6, 0 ) ), 0.25 * texel );

		let pass;

		if ( size > MIN_SIZE ) {

			if ( this._blurPass === null ) this._blurPass = _createBlurPass();

			pass = this._blurPass;
			pass.radius.value = TAP_RADIUS * sourceSize / size;
			pass.level.value = Math.log2( SOURCE_SIZE / sourceSize );
			pass.spacing.value = spacing;

		} else {

			if ( this._spherePass === null ) this._spherePass = _createSpherePass();

			pass = this._spherePass;

		}

		pass.envMap.value = this._source.texture;
		pass.sigma.value = bakeSigma;

		this._render( pass.material, target );

	}

	_render( material, target ) {

		this._mesh.material = material;
		this._cubeCamera.renderTarget = target;
		this._cubeCamera.update( this._renderer, this._mesh );

	}

}

// sigma in radians for a blurriness in [ 0, 1 ]
function _getSigma( blurriness ) {

	const t = blurriness * 9 - 1;

	return ( t < 0 ? Math.max( t + 1, 0 ) : Math.pow( 2, t ) ) / 64;

}

function _createTarget( size, mipmaps = false ) {

	return new CubeRenderTarget( size, {
		type: HalfFloatType,
		colorSpace: LinearSRGBColorSpace,
		minFilter: mipmaps ? LinearMipmapLinearFilter : LinearFilter,
		magFilter: LinearFilter,
		generateMipmaps: mipmaps,
		depthBuffer: false
	} );

}

function _createMaterial( name ) {

	const material = new NodeMaterial();
	material.name = name;
	material.side = BackSide;
	material.blending = NoBlending;
	material.depthTest = false;
	material.depthWrite = false;

	return material;

}

function _createCopyPass( sourceTexture ) {

	// one sampler node for all taps
	const direction = property( 'vec3', 'sampleDirection' );

	let envMap;

	if ( sourceTexture.isCubeTexture === true ) {

		envMap = cubeTexture( sourceTexture, direction, 0 );

	} else if ( sourceTexture.mapping === CubeUVReflectionMapping ) {

		envMap = pmremTexture( sourceTexture, direction, 0 );

	} else {

		envMap = texture( sourceTexture, equirectUV( direction ), 0 );

	}

	const material = _createMaterial( 'CubemapBlurCopy' );

	material.fragmentNode = Fn( () => {

		// Supersample so sources larger than the copy keep their energy (e.g. small HDR suns).
		const dx = dFdx( positionWorldDirection ).div( SUPERSAMPLING ).toVar();
		const dy = dFdy( positionWorldDirection ).div( SUPERSAMPLING ).toVar();
		const origin = positionWorldDirection.sub( dx.add( dy ).mul( 0.5 * ( SUPERSAMPLING - 1 ) ) ).toVar();

		const color = vec3( 0.0 ).toVar();

		Loop( SUPERSAMPLING, SUPERSAMPLING, ( { i, j } ) => {

			direction.assign( normalize( origin.add( dx.mul( float( i ) ) ).add( dy.mul( float( j ) ) ) ) );

			color.addAssign( envMap.rgb );

		} );

		return vec4( color.div( SUPERSAMPLING * SUPERSAMPLING ), 1.0 );

	} )();

	return { material, texture: sourceTexture };

}

function _createBlurPass() {

	const envMap = cubeTexture( _defaultCubeTexture );
	const sigma = uniform( 0 );
	const level = uniform( 0 );
	const spacing = uniform( 0 );
	const radius = uniform( 0, 'int' );

	const material = _createMaterial( 'CubemapBlur' );

	material.fragmentNode = Fn( () => {

		const direction = positionWorldDirection;

		const up = select( abs( direction.z ).lessThan( 0.999 ), vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ) );
		const tangent = normalize( cross( up, direction ) ).toVar();
		const bitangent = cross( direction, tangent ).toVar();

		const k = float( - 0.5 ).div( sigma.mul( sigma ) ).toVar();

		const color = vec3( 0.0 ).toVar();
		const weightSum = float( 0.0 ).toVar();

		// grid of taps on the tangent plane, weighted by the Gaussian of the angle
		// to the tap and the solid angle its cell covers on the sphere, the uniform
		// bounds keep the compiler from unrolling the loops
		const range = { start: radius.negate(), end: radius, condition: '<=' };

		Loop( range, range, ( { i, j } ) => {

			const offset = vec2( float( i ), float( j ) ).mul( spacing ).toVar();
			const r2 = dot( offset, offset ).toVar();

			const theta = atan( sqrt( r2 ) );
			const weight = exp( k.mul( theta.mul( theta ) ) ).mul( inverseSqrt( r2.add( 1.0 ).pow( 3.0 ) ) ).toVar();

			const tap = direction.add( tangent.mul( offset.x ) ).add( bitangent.mul( offset.y ) );

			color.addAssign( envMap.sample( tap ).level( level ).rgb.mul( weight ) );
			weightSum.addAssign( weight );

		} );

		return vec4( color.div( weightSum ), 1.0 );

	} )();

	return { material, envMap, sigma, level, spacing, radius };

}

function _createSpherePass() {

	const envMap = cubeTexture( _defaultCubeTexture );
	const sigma = uniform( 0 );
	const level = Math.log2( SOURCE_SIZE / SPHERE_SOURCE_SIZE );
	const n = SPHERE_SOURCE_SIZE;

	const material = _createMaterial( 'CubemapBlurSphere' );

	material.fragmentNode = Fn( () => {

		const direction = positionWorldDirection;

		const k = float( - 0.5 ).div( sigma.mul( sigma ) ).toVar();

		const color = vec3( 0.0 ).toVar();
		const weightSum = float( 0.0 ).toVar();

		// every texel of the source level, weighted by the Gaussian of its angle and its solid angle,
		// the face orientation does not matter for a sum over all of them
		Loop( 6 * n * n, ( { i: t } ) => {

			const face = t.div( n * n ).toVar();
			const texel = t.sub( face.mul( n * n ) ).toVar();

			const st = vec2( float( texel.mod( n ) ), float( texel.div( n ) ) ).add( 0.5 ).div( n ).mul( 2.0 ).sub( 1.0 ).toVar();
			const s = select( face.mod( 2 ).equal( 0 ), 1.0, - 1.0 );
			const axis = face.div( 2 );

			const d = select( axis.equal( 0 ), vec3( s, st ), select( axis.equal( 1 ), vec3( st.x, s, st.y ), vec3( st, s ) ) ).toVar();
			const r2 = dot( d, d ).toVar();

			const theta = acos( clamp( dot( direction, d.mul( inverseSqrt( r2 ) ) ), - 1.0, 1.0 ) );
			const weight = exp( k.mul( theta.mul( theta ) ) ).mul( inverseSqrt( r2.mul( r2 ).mul( r2 ) ) ).toVar();

			color.addAssign( envMap.sample( d ).level( level ).rgb.mul( weight ) );
			weightSum.addAssign( weight );

		} );

		return vec4( color.div( weightSum ), 1.0 );

	} )();

	return { material, envMap, sigma };

}

export default CubemapBlurGenerator;
