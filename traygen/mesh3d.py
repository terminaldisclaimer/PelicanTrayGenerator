"""3D helpers: polygon extrusion, boolean ops, chamfer lofts, watertight fixes."""

from __future__ import annotations

import numpy as np
import trimesh
from shapely.geometry import Polygon


def extrude(poly: Polygon, height: float, z: float = 0.0) -> trimesh.Trimesh:
    """Extrude a shapely polygon to a solid, optionally lifted to ``z``."""
    mesh = trimesh.creation.extrude_polygon(poly, height=height)
    if z:
        mesh.apply_translation([0.0, 0.0, z])
    return mesh


def difference(a: trimesh.Trimesh, b: trimesh.Trimesh,
               engine: str = "manifold") -> trimesh.Trimesh:
    return _boolean(a, b, "difference", engine)


def union(meshes: list[trimesh.Trimesh],
          engine: str = "manifold") -> trimesh.Trimesh:
    meshes = [m for m in meshes if m is not None]
    if len(meshes) == 1:
        return meshes[0]
    return _boolean(meshes, None, "union", engine)


def _boolean(a, b, op: str, engine: str):
    try:
        if op == "union":
            return trimesh.boolean.union(a, engine=engine)
        if op == "difference":
            return trimesh.boolean.difference([a, b], engine=engine)
    except Exception:
        # Fall back to trimesh's default engine if the requested one is missing.
        if op == "union":
            return trimesh.boolean.union(a)
        return trimesh.boolean.difference([a, b])
    raise ValueError(op)


def _ring_points(poly: Polygon, n: int) -> np.ndarray:
    ext = poly.exterior
    length = ext.length
    return np.array([ext.interpolate(length * i / n).coords[0] for i in range(n)])


def chamfer_frustum(poly_bottom: Polygon, z_bottom: float,
                    poly_top: Polygon, z_top: float,
                    n: int = 256) -> trimesh.Trimesh:
    """A closed tapered solid between two rings, used as a chamfer cut.

    The two rings are resampled to the same vertex count so the side wall and
    both caps share boundary vertices -> reliably watertight.
    """
    b = _ring_points(poly_bottom, n)
    t = _ring_points(poly_top, n)
    verts = np.vstack([
        np.column_stack([b, np.full(n, z_bottom)]),
        np.column_stack([t, np.full(n, z_top)]),
    ])
    faces: list[list[int]] = []
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, j, n + j])
        faces.append([i, n + j, n + i])
    # Fan-triangulate the caps from each ring's centroid (added vertices).
    cb = len(verts)
    verts = np.vstack([verts, [[*b.mean(axis=0), z_bottom]]])
    for i in range(n):
        j = (i + 1) % n
        faces.append([cb, j, i])            # bottom cap (downward)
    ct = len(verts)
    verts = np.vstack([verts, [[*t.mean(axis=0), z_top]]])
    for i in range(n):
        j = (i + 1) % n
        faces.append([ct, n + i, n + j])    # top cap (upward)

    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    mesh.fix_normals()
    return mesh


def make_watertight(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Best-effort cleanup so exported meshes are manifold and watertight.

    The manifold3d boolean backend already returns clean watertight meshes, so
    when the mesh is fine we leave it untouched (aggressive re-welding can
    collapse thin features such as chamfers). Only attempt repair otherwise.
    """
    if mesh.is_watertight and mesh.is_winding_consistent:
        return mesh
    mesh.merge_vertices()
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    mesh.fix_normals()
    if not mesh.is_watertight:
        try:
            trimesh.repair.fill_holes(mesh)
            mesh.fix_normals()
        except Exception:
            pass
    return mesh
