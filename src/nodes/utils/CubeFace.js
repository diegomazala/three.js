import { Fn, vec3 } from '../tsl/TSLBase.js';
import { abs, clamp, max, min } from '../math/MathNode.js';
import { select } from '../math/ConditionalNode.js';

/**
 * Direction (not normalized) of PMREM face coordinates (see `getUV`) that may lie past the face
 * edge. The texel grid continues into the neighbouring face at the same texel index along the edge,
 * so coordinates past the edge land on the neighbour's texel centers rather than on the extrapolated
 * face plane.
 *
 * @tsl
 * @function
 * @param {Node<float>} face - The face index.
 * @param {Node<vec2>} uv - The face coordinates.
 * @return {Node<vec3>} The direction.
 */
export const cubeFaceDir = /*@__PURE__*/ Fn( ( [ face, uv ] ) => {

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
