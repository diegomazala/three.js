import { BackSide, CubeUVReflectionMapping, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, LinearSRGBColorSpace, NoBlending } from '../constants.js';
import { BoxGeometry } from '../geometries/BoxGeometry.js';
import { CubeCamera } from '../cameras/CubeCamera.js';
import { floorPowerOfTwo } from '../math/MathUtils.js';
import { Mesh } from '../objects/Mesh.js';
import { ShaderMaterial } from '../materials/ShaderMaterial.js';
import { ShaderLib } from '../renderers/shaders/ShaderLib.js';
import { WebGLCubeRenderTarget } from '../renderers/WebGLCubeRenderTarget.js';

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
	 * @param {WebGLRenderer} renderer - The renderer.
	 */
	constructor( renderer ) {

		this._renderer = renderer;
		this._mesh = new Mesh( new BoxGeometry( 5, 5, 5 ), null );
		this._cubeCamera = new CubeCamera( 1, 10, null );

		this._source = null;
		this._sourceTexture = null;
		this._sourceVersion = - 1;

		this._copyMaterial = null;
		this._blurMaterial = null;
		this._sphereMaterial = null;

	}

	/**
	 * Blurs an equirectangular, cube or PMREM (cubeUV) texture. Blurriness `1 / 9` gives a
	 * sigma of 0.9 degrees, every further `1 / 9` doubles it up to the average of the whole
	 * map at `1`, below `1 / 9` the blur ramps down to sharp.
	 *
	 * @param {Texture} texture - The environment texture.
	 * @param {number} blurriness - The blurriness in the range `[0,1]`.
	 * @param {?WebGLCubeRenderTarget} [renderTarget=null] - A previous result to update, replaced when its size does not fit.
	 * @return {WebGLCubeRenderTarget} The cube render target with the blurred environment.
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

		const autoClear = renderer.autoClear;
		renderer.autoClear = false;

		this._copy( texture );
		this._blur( target, sigma );

		renderer.autoClear = autoClear;

		return target;

	}

	/**
	 * Frees the GPU-related resources allocated by this instance. Call this method whenever this instance is no longer used in your app.
	 */
	dispose() {

		if ( this._source !== null ) this._source.dispose();
		if ( this._copyMaterial !== null ) this._copyMaterial.dispose();
		if ( this._blurMaterial !== null ) this._blurMaterial.dispose();
		if ( this._sphereMaterial !== null ) this._sphereMaterial.dispose();

		this._mesh.geometry.dispose();

	}

	// private interface

	_copy( texture ) {

		if ( this._sourceTexture === texture && this._sourceVersion === texture.pmremVersion ) return;

		if ( this._source === null ) this._source = _createTarget( SOURCE_SIZE, true );

		if ( this._copyMaterial === null ) this._copyMaterial = _createCopyMaterial();

		const uniforms = this._copyMaterial.uniforms;

		uniforms.envMap.value = texture;
		uniforms.flipEnvMap.value = ( texture.isCubeTexture && texture.isRenderTargetTexture === false ) ? - 1 : 1;

		this._render( this._copyMaterial, this._source );

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

		let material;

		if ( size > MIN_SIZE ) {

			if ( this._blurMaterial === null ) this._blurMaterial = _createBlurMaterial();

			material = this._blurMaterial;
			material.uniforms.radius.value = TAP_RADIUS * sourceSize / size;
			material.uniforms.level.value = Math.log2( SOURCE_SIZE / sourceSize );
			material.uniforms.spacing.value = spacing;

		} else {

			if ( this._sphereMaterial === null ) this._sphereMaterial = _createSphereMaterial();

			material = this._sphereMaterial;

		}

		material.uniforms.envMap.value = this._source.texture;
		material.uniforms.sigma.value = bakeSigma;

		this._render( material, target );

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

	return new WebGLCubeRenderTarget( size, {
		type: HalfFloatType,
		colorSpace: LinearSRGBColorSpace,
		minFilter: mipmaps ? LinearMipmapLinearFilter : LinearFilter,
		magFilter: LinearFilter,
		generateMipmaps: mipmaps,
		depthBuffer: false
	} );

}

function _createMaterial( name, defines, uniforms, fragmentShader ) {

	return new ShaderMaterial( {

		name: name,
		defines: defines,
		uniforms: uniforms,
		vertexShader: ShaderLib.cube.vertexShader,
		fragmentShader: fragmentShader,
		side: BackSide,
		blending: NoBlending,
		depthTest: false,
		depthWrite: false

	} );

}

function _createCopyMaterial() {

	const material = _createMaterial( 'CubemapBlurCopy', { 'SUPERSAMPLING': SUPERSAMPLING }, {

		'envMap': { value: null },
		'flipEnvMap': { value: 1 }

	}, /* glsl */`

		#include <common>
		#include <cube_uv_reflection_fragment>

		#ifdef ENVMAP_TYPE_CUBE

			uniform samplerCube envMap;
			uniform float flipEnvMap;

		#else

			uniform sampler2D envMap;

		#endif

		varying vec3 vWorldDirection;

		vec3 sampleSource( vec3 direction ) {

			#if defined( ENVMAP_TYPE_CUBE )

				return textureCubeLodEXT( envMap, vec3( flipEnvMap * direction.x, direction.yz ), 0.0 ).rgb;

			#elif defined( ENVMAP_TYPE_CUBE_UV )

				return textureCubeUV( envMap, direction, 0.0 ).rgb;

			#else

				return texture2DLodEXT( envMap, equirectUv( direction ), 0.0 ).rgb;

			#endif

		}

		void main() {

			// Supersample so sources larger than the copy keep their energy (e.g. small HDR suns).
			vec3 dx = dFdx( vWorldDirection ) / float( SUPERSAMPLING );
			vec3 dy = dFdy( vWorldDirection ) / float( SUPERSAMPLING );
			vec3 origin = vWorldDirection - ( dx + dy ) * 0.5 * float( SUPERSAMPLING - 1 );

			vec3 color = vec3( 0.0 );

			for ( int i = 0; i < SUPERSAMPLING; i ++ ) {

				for ( int j = 0; j < SUPERSAMPLING; j ++ ) {

					color += sampleSource( normalize( origin + float( i ) * dx + float( j ) * dy ) );

				}

			}

			gl_FragColor = vec4( color / float( SUPERSAMPLING * SUPERSAMPLING ), 1.0 );

		}
	` );

	// let the renderer derive the ENVMAP_TYPE_* and CUBEUV_* defines from the source texture,
	// equirectangular textures fall through to the last branch of the shader
	Object.defineProperty( material, 'envMap', {

		get: function () {

			const texture = this.uniforms.envMap.value;

			return ( texture !== null && ( texture.isCubeTexture || texture.mapping === CubeUVReflectionMapping ) ) ? texture : null;

		}

	} );

	return material;

}

function _createBlurMaterial() {

	return _createMaterial( 'CubemapBlur', {}, {

		'envMap': { value: null },
		'sigma': { value: 0 },
		'level': { value: 0 },
		'spacing': { value: 0 },
		'radius': { value: 0 }

	}, /* glsl */`

		#include <common>

		uniform samplerCube envMap;
		uniform float sigma;
		uniform float level;
		uniform float spacing;
		uniform int radius;

		varying vec3 vWorldDirection;

		void main() {

			vec3 direction = normalize( vWorldDirection );

			vec3 up = abs( direction.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
			vec3 tangent = normalize( cross( up, direction ) );
			vec3 bitangent = cross( direction, tangent );

			float k = - 0.5 / ( sigma * sigma );

			vec3 color = vec3( 0.0 );
			float weightSum = 0.0;

			// grid of taps on the tangent plane, weighted by the Gaussian of the angle
			// to the tap and the solid angle its cell covers on the sphere, the uniform
			// bounds keep the compiler from unrolling the loops
			for ( int i = - radius; i <= radius; i ++ ) {

				for ( int j = - radius; j <= radius; j ++ ) {

					vec2 offset = vec2( float( i ), float( j ) ) * spacing;
					float r2 = dot( offset, offset );

					float theta = atan( sqrt( r2 ) );
					float weight = exp( k * theta * theta ) * inversesqrt( ( 1.0 + r2 ) * ( 1.0 + r2 ) * ( 1.0 + r2 ) );

					color += weight * textureCubeLodEXT( envMap, direction + offset.x * tangent + offset.y * bitangent, level ).rgb;
					weightSum += weight;

				}

			}

			gl_FragColor = vec4( color / weightSum, 1.0 );

		}
	` );

}

function _createSphereMaterial() {

	return _createMaterial( 'CubemapBlurSphere', { 'SIZE': SPHERE_SOURCE_SIZE, 'LEVEL': Math.log2( SOURCE_SIZE / SPHERE_SOURCE_SIZE ) + '.0' }, {

		'envMap': { value: null },
		'sigma': { value: 0 }

	}, /* glsl */`

		#include <common>

		uniform samplerCube envMap;
		uniform float sigma;

		varying vec3 vWorldDirection;

		void main() {

			vec3 direction = normalize( vWorldDirection );

			float k = - 0.5 / ( sigma * sigma );

			vec3 color = vec3( 0.0 );
			float weightSum = 0.0;

			// every texel of the source level, weighted by the Gaussian of its angle and its solid angle,
			// the face orientation does not matter for a sum over all of them
			for ( int t = 0; t < 6 * SIZE * SIZE; t ++ ) {

				int face = t / ( SIZE * SIZE );
				int texel = t - face * SIZE * SIZE;

				vec2 st = ( vec2( float( texel % SIZE ), float( texel / SIZE ) ) + 0.5 ) / float( SIZE ) * 2.0 - 1.0;
				float s = face % 2 == 0 ? 1.0 : - 1.0;
				int axis = face / 2;

				vec3 d = axis == 0 ? vec3( s, st ) : axis == 1 ? vec3( st.x, s, st.y ) : vec3( st, s );
				float r2 = dot( d, d );

				float theta = acos( clamp( dot( direction, d * inversesqrt( r2 ) ), - 1.0, 1.0 ) );
				float weight = exp( k * theta * theta ) * inversesqrt( r2 * r2 * r2 );

				color += weight * textureCubeLodEXT( envMap, d, LEVEL ).rgb;
				weightSum += weight;

			}

			gl_FragColor = vec4( color / weightSum, 1.0 );

		}
	` );

}

export { CubemapBlurGenerator };
